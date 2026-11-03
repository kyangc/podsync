# 2026-11-03：已恢复的 YouTube discovery 超时与远端 EOF 复核

本次为 11 月 3 日 07:57–08:07（北京时间）的日常巡检告警后续。
服务当前可用；没有发现需修改代码、配置或重启的缺陷，以只读证据结案。
两次 discovery 失败、一次 metadata 最终上报警告和一次事件批次内部失败分别保留，
不把它们归为同一根因，也不宣称底层网络问题已根治。

## 两次 YouTube API discovery 失败

| 样本 | 原失败时间 | 原错误位置 | 本次 feed 总耗时 | 首次后续完整更新成功 | 截至读回连续成功 |
| --- | --- | --- | --- | --- | --- |
| A | 11/2 22:59:23 | `failed to query playlist items: context deadline exceeded` | 30.680 秒 | 11/3 00:00:00 | 9 次，最近 08:00:33 |
| B | 11/3 00:00:44 | `failed to query video descriptions: context deadline exceeded` | 30.688 秒 | 11/3 00:59:29 | 8 次，最近 07:59:38 |

原 stdout 和 D1 `error_detail` 一致。调用分别来自 `YouTubeBuilder.listPlaylistItems`
和 `queryVideoDescriptions` 的 Google API 请求，不是初始化失败或 yt-dlp 下载超时。
两者均经 `httpretry.Do`：每次逻辑调用共享 30 秒期限，最多两次尝试，退避 250ms；
期限到达优先返回，不增加新预算。表中耗时包含同一 feed 的其他步骤，不能当作单次
HTTP 请求精确耗时，也没有证据确认内部实际尝试次数。

`Build` 出错后 `updateFeed` 返回，未进入此次结果的 `AddFeed` 或下载处理。
两条失败事件没有 episode 任务 ID，因此后续 feed 成功不能称为某个失败节目下载恢复。
下一 feed 均继续成功；原进程和媒体消费者未重建，RestartCount 均为 0。

现有有界 HTTP 诊断覆盖远端请求和 Bilibili discovery，未接入上述 YouTube API 请求，
不能据此识别原调用的 DNS、连接、TLS、首字节或读取阶段。
A 后约 3 秒、B 前约 32 秒及后约 18 秒的应用诊断样本仍有约 3.9–4.0GB 可用内存、
内存压力采样为 0；这些离散样本不能排除原窗口内短暂资源或网络异常。
宿主恢复器自昨日验收后没有新失败；17:12:01–17:12:03 的共享维护等待与两次失败不重合。
未找到能把期限耗尽唯一归因于供应商、网络或平台的证据。

## 远端调用：内部重试与最终警告分开

- 11/2 15:33:51：`remote_events` 内部调用 EOF，耗时 2069ms，原共享预算 29999ms。
  记录显示 `stage=tls`、未观察到写请求或响应头，但两次连接获取使
  `trace_ambiguous=true`，不能推断唯一阻塞阶段或证明服务端未接收请求。
  该批后续事件已在 D1 读回，所属 15:02:50–16:03:49 轮为 success；
  121 条唯一连续序号 1–121，28 feed / 1 download / 1 upload / errors 0 与事件计数一致。
  没有最终事件上传警告；原失败请求的接收结果仍未知，最终批次结果已闭合。
- 11/2 17:59:07 和 17:59:09：同一 feed C 的 metadata 上报两次 EOF。
  第一次 5594ms，复用连接，观察到请求写出、未收到响应头，`stage=first_byte`；
  第二次 1946ms，剩余共享预算 24155ms，未观察到写请求或响应头，
  两次连接获取且 `trace_ambiguous=true`。这次既有重试并未立即成功，stdout 明确记录
  **一条 `remote feed metadata upsert failed` 最终警告**，不是下载摘要警告。
  该 feed 仍可完成本地发布，不能用 `feed_update_finished` 或 D1 errors 0 代替 metadata 验收。
  后续自然更新持续成功；08:04 读回 D1 的 `reported_at` 已推进到 07:59:52，
  对应现有媒体交付也通过。原两次请求是否曾被接收无法从覆盖写的 metadata 表反推。

三条原应用失败诊断的 dropped / write-failure 快照均为 0。
这些 EOF 与两次 YouTube discovery 超时不重合；阶段字段是线索，不是底层根因证明。

## 可观察结果与覆盖边界

08:04 D1 查询按轮次开始时间取昨日 09:47:13 之后的 22 轮，结果为
19 success / 2 partial / 1 running，累计 642 feed / 18 download / 18 upload / errors 2。
所有轮次序号唯一连续，持久累计计数与对应事件计数一致；所有 SELECT 的 rows_written 为 0。
此窗口不同于父巡检的滚动 24 小时，不能直接比较其轮次或下载总数。
最近完成轮为 06:17:50–07:18:49 success（28 / 1 / 1 / errors 0）；
当前 07:18:49 起的正常运行轮已自然推进至 28 / 1 / 1 / errors 0，最新事件 08:02:50。

08:05 按 feed/episode 关联窗口内全部 18 个已发现节目，每个均有一次发现、下载成功、
发布成功和上报成功，失败事件为 0，D1 状态均 visible。
这是已观察到任务的完整性核对，不证明失败窗口内源端曾存在、后来消失的内容没有遗漏；
未手工重跑同步或补造未知任务。

父巡检的四个固定样本与本次补查的最新自然发布样本、metadata feed C 样本，大小分别为
11,033,820 / 11,221,860 / 20,814,611 / 29,999,722 / 25,650,310 / 3,174,878 字节。
六个样本的 Mac/NAS 两侧 RSS 均 200、enclosure 唯一、length 与 D1 一致；
12 次媒体请求均为 Range 206、1024 字节、Content-Range 总长正确。
每个公开前缀与容器 `/app/data/.remote-media` 文件的前 1024 字节 SHA-256 一致，
源文件大小正确，并与对应下载文件保持同设备、同 inode。
Worker 200/ok、媒体 healthz 204，未认证 dashboard 302 到原 Access，TLS 校验均通过。
均沿用原 30 秒 curl 期限，无额外失败重试。

08:04 生产读回仍为实际登记的两个消费者 healthy、门禁通过、RestartCount 0，
最近完整 feed 发布 08:00:38；原 `7ce14e3` 恢复器 ready、历史事故 56、attempts 0、
两个 streak 均为 0，应用仍为 `9efb508`。
未改动 Cookie、数据库、队列、媒体、门禁、期限和预算。

脱敏结论保存在本文件；原 stdout、D1 读回、诊断和媒体证据位于内置盘
`runtime/private/podsync-followup-20261103/`，目录 0700、文件 0600。
本次 stdout 查询从昨日 09:47:13 开始，不冒称完整近 24 小时归档；
昨日停机与旧 writer 日志的覆盖边界沿用[已完成的审查记录](2026-11-02-writer-exit-after-platform-reboot.md)。
仅增加文档并检查链接、脱敏和 diff，无运行时代码变更，未执行完整 Go 测试或部署。
