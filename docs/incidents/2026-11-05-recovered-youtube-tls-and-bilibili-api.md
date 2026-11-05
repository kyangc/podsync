# 2026-11-05：已恢复的 YouTube TLS 下载与 Bilibili API 告警复核

时间均为 Asia/Taipei（UTC+8）。本次跟进 11 月 5 日的两项新增巡检告警。
**两项均已自然恢复，原样本当前交付正常；未发现需要代码、配置或运行修复的缺陷。**
未重启、部署、手工重跑同步或放宽重试预算，以原始证据和自然后续结果结案。
底层 YouTube TLS 超时原因及 Bilibili 内部服务超时原因仍未定位。

## YouTube：一次下载尝试超时，第二次尝试成功

11/4 15:11:56 的两条 error 与一条 `retrying transient YouTube download`
属于同一节目、同一次下载尝试，不能算成三起终态失败。
原 yt-dlp 输出明确为 `_ssl.c:1064: The handshake operation timed out`，
并在其内部一次重试后放弃；未见该次尝试的 HTTP 403，亦非 discovery 失败。

原重试摘要为：

| 字段 | 原值 |
| --- | --- |
| `attempt_elapsed_ms` / `queue_wait_ms` | 92240 / 0 |
| `last_stage` / `retry_reason` | media / tls_transport |
| `next_attempt` / `max_attempts` | 2 / 3 |
| `metadata_available` / `protocol` | true / https |
| `format_id` / `audio_codec` | 18 / mp4a.40.2 |
| `configured_player_client` | mweb |
| `output_bytes` / `output_truncated` / `no_data_blocks` | 2442 / false / false |

管理器沿用既有预算重试。15:15:00 的最终摘要为 success、attempts 2、
总耗时 275448ms、最后一次进程耗时 178205ms、排队 0、阶段 complete。
`configured_player_client` 只表示配置值，`last_stage` 也不能定位 TLS 失败的具体请求。

原同一 feed/episode 的 D1 链为：

| 事件 | 时间 |
| --- | --- |
| discovered | 11/4 15:10:24 |
| download_finished | 11/4 15:15:00 |
| upload_finished | 11/4 15:19:51 |
| report_finished | 11/4 15:19:52 |

无该节目的失败事件。现有媒体为 17,860,321 字节，实际交付核验见下文。
没有证据将原 TLS 超时唯一归因于外站、网络、NAS 或 APFS。

## Bilibili：HTTP 已完成，供应商返回 -504

11/4 18:10:25 stdout 与 D1 均为 `bilibili api error: 服务调用超时`；
D1 为一条 `feed_update_failed`，没有 episode ID。
原 `bilibili_discovery` 有界 HTTP 诊断进一步确认：

- HTTP 200、供应商 `provider_code=-504`、`error_kind=application`。
- 耗时 282ms，客户端期限 10000ms；连接复用，只有一次连接获取，trace 无歧义。
- 已写出请求、收到响应头、完整读取 113 字节至 EOF，关闭未失败。
- 首字节 281ms，正文读取不足 1ms；记录的 `body_read` 是完成读取后识别业务错误的阶段。
- 当次 dropped / write-failure 快照均为 0。

因此这是供应商响应中的服务调用超时，不能写成本地十秒 HTTP 期限耗尽或 TLS 失败。
调用属于原用户空间 feed 的 builder discovery/API 阶段；诊断不保存 endpoint 或请求标识，
不能仅凭这条记录进一步断言具体 API 路径或某个视频请求失败。
错误响应来源已定界，但供应商内部何处超时仍未知。

`Build` 返回错误后，`updateFeed` 尚未执行此次结果的 `AddFeed`，
外层 `Update` 也未进入下载、清理和 XML 发布；不能称为某个已发现节目下载失败。
原有记录保留，调度器继续其他 feed，下一轮按原列表查询规则重新抓取。

原 feed 于 19:10:41 自然开始下一轮，19:10:42 发现节目、19:10:46 下载及完整 feed
更新成功，19:14:51 发布、19:14:52 上报成功。该自然发布样本为 1,677,606 字节。
08:05 读回确认失败后已有 13 次完整更新成功，最近为 11/5 07:11:02，metadata 亦已推进。

本轮最终读回的六项 SELECT 均为 `rows_written=0`。从 11/4 08:09:47 起，
17 个已观察到的新发现节目，各有一次 discovered、download、upload、report 成功，
关联错误均为 0。该范围不同于父巡检滚动 24 小时的事件窗口，不能混用总数。
它证明已观察任务的后续链路闭合，不能证明失败窗口内源端曾出现、随后消失的内容没有遗漏。
未补造未知任务或手工重放同步。

## 实际交付与生产状态

父巡检于 08:01–08:03 对最新两个样本和上述两项原异常关联样本完成真实交付核验，
大小依次为 14,516,450 / 25,702,021 / 1,677,606 / 17,860,321 字节：

- Mac/NAS 两侧共八份 RSS 均 200、enclosure 唯一，length 与 D1 相符。
- 八次媒体 Range 均 206、1024 字节，Content-Range 总长正确、TLS 校验通过。
- 双侧前 1024 字节 SHA-256 与 producer 对应源文件一致；源大小与 D1 相符，
  每份媒体恰有一个原下载文件同设备、同 inode。
- 双侧 Worker 200/ok、媒体 healthz 204，未认证 dashboard 302 到原 Access。

08:05–08:06 本线程读回两个原消费者均 running/healthy、RestartCount 0、登记 ID 匹配，
StartedAt 仍为 11/4 08:09:47，登记 writer 为一，实际应用进程亦为一。
恢复器 ready、inspection 历史 56、attempts 0、两个 streak 均 0。
使用原 gate 参数并以 `/bin/true` 替换原业务命令，实际双门禁均返回 0。
内部健康 healthy，最近完整 feed 发布为 07:12:47。
应用仍为 `9efb508`，控制器仍为 `79bbbe2`；未改变原 ACK、双时钟 TTL、期限或预算。

核验命令有两次参数错误，已作为探针偏差私有留证：第一次遗漏 gate 参数而返回 78；
第二次误将原应用命令也带入，producer 命令立即退出 1，随后改为仅运行 gate 和 `/bin/true`。
该次 stderr 只保留了开头，未保留具体 fatal 行，不能称为原日志已确认退出原因。
当前读回显示生产 PID 1 持有数据库目录独占 flock；结合相同生产配置、Badger 在打开
manifest 前先取得独占锁的实现及启动顺序，支持其在打开数据库时被拒绝的推断。
未为核验再次启动应用或打开生产数据库，原生产进程、容器身份与任务持续保留。

未将没有新增控制失败解释为底层 APFS 停顿已根治；该问题仍沿用
[11 月 4 日事故记录](2026-11-04-guest-lease-io-stall.md) 的未知边界。
启动时 GitHub 自更新 403 和两个既有 Bilibili unavailable 样本属于已保留问题，
不与本次两项新瞬态混算，也未手工触发更新以制造恢复。

脱敏结论保存在本文件；原 stdout、D1 读回、HTTP 诊断、父巡检交付摘要和探针偏差
保存在内置盘 `runtime/private/podsync-followup-20261105/`，目录 0700、文件 0600，
已记录大小与 SHA-256。stdout 按当前原 ID 查询，覆盖多个启动会话；
父巡检另已核对昨日截至正常 drain 的日志归档及新会话，未以 D1 代替日志覆盖证明。
本次仅新增文档，检查链接、脱敏和 git diff；未执行完整 Go 测试或部署。
