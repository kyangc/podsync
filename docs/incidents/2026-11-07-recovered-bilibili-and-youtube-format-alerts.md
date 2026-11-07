# 2026-11-07：Bilibili API 与两轮 YouTube 格式告警自然恢复

时间均为 Asia/Taipei（UTC+8）。本次跟进日常巡检新增的一条 feed 失败和两条节目下载失败。
**原任务已自然恢复，原 YouTube 节目真实交付通过；未发现足以支持代码、配置或运行修复的稳定缺陷。**
本次仅记录证据，没有部署、重启、手工重跑同步、改变下载条件或清理失败历史。
恢复结论不等于根因已证实。

## Bilibili：供应商返回 -504，下一轮恢复

11/6 19:11:34，原用户空间 feed 的 discovery/API 返回
`bilibili api error: 服务调用超时`，对应一条 D1 `feed_update_failed`，没有 episode ID。
原 `bilibili_discovery` 有界诊断为：

- HTTP 200、`provider_code=-504`、`error_kind=application`、耗时 284ms。
- 客户端限制 10000ms，context 未取消；复用连接，一次连接获取，trace 无歧义。
- 请求已写出、响应头已收到，113 字节正文完整读至 EOF，关闭未失败。
- `stage=body_read`，首字节 283ms、正文读取不足 1ms；drop / write-failure 快照均为 0。

因此可确认错误来自供应商业务响应，不能解释成本地十秒期限耗尽或 TLS 失败。
供应商内部何处超时仍未知；诊断没有保存 endpoint，不能进一步断言具体 API 路径。
与[11/5 复核的旧 -504](2026-11-05-recovered-youtube-tls-and-bilibili-api.md)属于不同调用。

原 feed 20:12:39 自然开始下一轮，20:12:41 完整更新成功。
本线程按原 feed 身份读回，从该轮至 11/7 07:11:50 共 12 条 `feed_update_finished`，
没有后续 feed 失败。该次失败推迟了这一轮源内容查询；下一轮成功不能证明失败窗口内
曾出现又消失、从未被观察到的内容没有遗漏。

当前交付核验使用该 feed 已有的 1,959,919 字节媒体，其 D1 更新时间为 11/3 23:02:50。
它证明旧内容当前可交付，不能称为本次失败后新发现、下载或发布的恢复样本。

## YouTube：同一节目两次终态失败，第三轮自然发布

| 下载失败 | 总耗时 / 进程耗时（ms） | 排队（ms） |
| --- | --- | --- |
| 11/6 23:11:39 | 9373 / 9372 | 0 |
| 11/7 00:11:43 | 8433 / 8432 | 0 |

两次 yt-dlp 终态输出均为 `Requested format is not available`。
每轮的两条 error 和一条 warning 摘要属于同一次操作，对应一条 D1
`episode_download_failed`、`error_code=download_failed`；合计两个失败事件、一个节目。
节目身份与[11/6 记录的四轮失败](2026-11-06-recovered-youtube-format-unavailable.md)不同。

共同摘要为 attempts 1、failed、downloader_error、last_stage extract、
metadata_available false、configured_player_client mweb、output_bytes 538、
output_truncated false、no_data_blocks false。
原输出打印网页、mweb config/player API、bgutil GVS PO Token、player 脚本和 Deno
challenge 步骤后报格式不可用。两次 player 标识不同，第二次仍失败；步骤日志不能证明
响应内容和求解结果全部有效。未见这两次操作的明确 TLS/EOF、403/429 或媒体读取超时提示。

当前接受的远端配置缓存仍为：

```text
18/best[protocol=https][vcodec!=none][acodec!=none]
```

该 feed 的最后一个 `--format` 覆盖默认音频选择器，仍转为 MP3；client 为 mweb，
沿用原 bgutil provider、socket timeout 12 秒、媒体/fragment retries 各 1、周期 1h。
远端缓存哈希与昨日相同，D1 feed 配置更新时间仍为 10/22 21:42:03。
当前缓存不能替代失败时完整参数快照。

失败时的格式清单、播放器响应及 challenge 结果没有保存，无法重放原失败条件。
`metadata_available=false` 只表示摘要没有取得白名单格式字段，不代表 discovery 元数据缺失。
源端格式变化、原选择器无法匹配、client/extractor/session 条件变化均无法由现有材料唯一判定；
也不能直接归因于直播转码或网络。[现有更新器](../../services/update/updater.go)保留错误节目，
按原调度再试；[已有测试](../../services/update/updater_test.go)明确约束纯格式错误不增加快速重试。
本轮未为无法重放的历史条件改变格式、client、Cookie、版本或重试预算。

| 原节目事件 | 时间 |
| --- | --- |
| 首次 discovered | 11/6 23:11:30 |
| 第三轮 discovered | 11/7 01:11:22 |
| download_finished | 01:12:01 |
| upload_finished / report_finished | 01:14:52 |
| D1 episode updated_at | 01:14:53 |

成功摘要为 attempts 1、总耗时 38998ms、进程 38997ms、排队 0、complete、
format_id 18、audio_codec mp4a.40.2、protocol https、metadata_available true、
output_bytes 8483、output_truncated false。现有 D1 状态 visible、大小 25,637,243 字节。
从首次发现到发布确认约两小时三分钟，存在实际交付延迟。

本线程直接读回原 feed 恢复后的完整更新事件为 01:12:02、02:11:01、03:10:53、
04:10:59、05:10:30、06:10:24、07:10:56。
原节目下载、发布、上报各一次，失败历史仍为两条。
失败轮也有 `feed_update_finished`，因此不能单凭该事件证明节目下载恢复，恢复判断使用上述同身份成功链。
初始交接曾误列该 feed 的几个后续时间，父巡检已撤回；本记录仅采用本线程实际查询结果。

## 内部 EOF 与巡检查询错误分别复核

11/6 15:15:24.465，应用诊断另有一条 `remote_config` 内部 EOF：940ms、
budget 29999ms、stage tls、request_written false、response_headers false、
connection_acquisitions 3、trace_ambiguous true，drop / write-failure 均为 0。
这条失败调用不等于最终配置获取失败；应用日志没有对应最终获取警告，D1 于 15:15:25
记录 `remote_config_fetched`，15:20:24、15:25:24 后续成功也已读回。
trace 存在歧义，不能把最后记录的 tls 阶段解释为唯一网络根因。

父巡检 07:57 的一次 Wrangler 远端 SELECT 返回 Cloudflare API 7403
（account not valid or not authorized）；随后原凭据下 `SELECT 1` 及两组五条原查询
均成功、rows_written 为 0。本线程随后七条关联 SELECT 亦全部成功、rows_written 为 0。
这支持当前读取已恢复，不能证明凭据曾过期或被撤销；没有登录登出、轮换 token 或更换账号。

## 任务闭合、真实交付与生产读回

从 11/6 08:00 起的关联查询观察到 19 个新节目，19 个均有下载、发布和上报成功。
窗口内 warn/error 仅为上述一条 feed 失败和同节目两条下载失败。
这是固定事件窗口的关联结果，不与按 run.started_at 统计的滚动 24 小时总量混用，
也不证明未被发现的内容没有遗漏。

父巡检于 08:00–08:03 验证最新样本、原 YouTube 恢复样本、原 Bilibili feed 旧样本，
大小分别为 23,994,530 / 25,637,243 / 1,959,919 字节：

- Mac/NAS 六份 RSS 均 200，enclosure 各唯一，length 与 D1 一致。
- 六次媒体 Range 均 206、1024 字节，Content-Range 总长正确，TLS verify 为 0。
- 源文件大小与 D1 相符，每份恰有一个原下载文件同设备、同 inode；双侧前 1024 字节
  SHA-256 与 producer `/app/data/.remote-media` 源文件一致。
- 双侧 Worker 200/ok、media healthz 204，未认证 dashboard 302 至原 Access。

本线程另读回原 YouTube、Bilibili 样本的源大小及唯一同 inode 原文件，结果一致。
08:03–08:04 两个原消费者均 healthy、RestartCount 0、StartedAt 仍为 11/4 08:09:47，
实际 ID 与登记相同，登记 writer 一，应用进程仅 PID 1。
双门禁探针均为 0；仅保留原 Entrypoint 至 `--`，将全部业务命令替换为 `/bin/true`。
恢复器 ready、attempts 0、两个 streak 0、inspection 历史 56。
Linux v2 租约 boot ID、generation 与当前会话相符，完整 nonce ACK JSON 与租约一致，
双时钟剩余约 9.94 秒、固定 TTL 各十秒。内部 health healthy，实例最近完整更新为 07:12:05；
该实例指标不冒充原 feed 的专属时间。

实际 `/app/podsync` SHA-256 与部署登记 binary_sha256 一致，对应源码 `9efb508`，
十二项登记控制制品哈希均匹配，控制器仍为 `79bbbe2`。
原完整 ACK、双时钟 TTL、两秒发布预算和 SSH/观察期限均保持。
一次辅助探针误把 ACK 当作纯 nonce 文本比较，已按完整租约 JSON 更正并留证；实际门禁始终通过。
没有新增控制故障不能证明[11/4 APFS 停顿](2026-11-04-guest-lease-io-stall.md)的未知触发者已根治。

原 ID 近 24 小时日志查询返回 82,982 行，首条为 11/6 08:05:24，末条为 11/7 08:00:24；
共 671 条完整 feed 更新成功，fatal/panic 为 0。当前轮转日志已无启动行，版本判断使用实际二进制哈希。
原日志、D1 结果、诊断、配置摘要、交付回执、辅助探针更正及运行读回保存在内置盘
`runtime/private/podsync-followup-20261107/`，目录 0700、文件 0600，记录大小和 SHA-256。
没有打开运行中 Badger 的第二个实例；源配置及 Cookie 哈希复核不变。
本次仅新增事故记录，按文档规则检查 Markdown 链接、脱敏与 git diff，无需完整 Go 测试或部署。
