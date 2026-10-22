# 2026-10-22 YouTube 直播回放格式暂时不可用

时间均为北京时间（UTC+8）。本文以 A 代替原失败集，不记录 feed/episode/run 标识、私密订阅或媒体完整地址、Cookie、Token。

## 故障证据与判断

- A 于 21:22:02 被发现，21:22:22 下载失败。NAS 完整输出与 D1 事件一致：mweb player API、GVS PO Token 请求及 Deno challenge 求解后，终态为 `Requested format is not available`。
- 下载摘要为 attempts=1、last_stage=extract、metadata_available=false、19978 毫秒，输出 538 字节且未截断。没有观察到 TLS/EOF、媒体读取超时、HTTP 403、仅剩图片、求解或 provider 失败提示。该证据不同于 [10 月 8 日播放器 API 传输故障](2026-10-08-youtube-player-api-transport.md)，不能直接套用旧根因。
- 21:32:43 内部 `/health` 仍为 503/unhealthy、failed_episodes=1；最近成功 feed 更新为 21:27:11。D1 当时没有 A 的 episode 行或后续发布确认。
- 同一容器、原 feed 下载参数的只读提取约 11 秒成功：A 为 `was_live`、public、2953 秒，选择 format 18、HTTPS、mp4a.40.2 音频与 avc1 视频；插件为 bgutil:http-2.0.2，Deno 为 2.7.4，yt-dlp 为 2026.08.19。没有传入 Cookie、下载媒体或使用磁盘 cache。
- YouTube Data API 随后读回 actualStartTime=20:30:10、actualEndTime=21:19:18、publishedAt=21:22:29。下载失败发生在直播结束约三分钟后、当前发布时刻前七秒。

已证实的直接故障是当次提取没有可匹配现有选择器的格式；当前相同选择器已能选择含音频的 format 18。直播转回放的处理窗口是有时间线支持的推断。失败时的 player JSON、可用格式列表和 challenge 结果没有保留，无法唯一确认是上游转码尚未完成，还是 session/提取结果变化；不能宣称已定位具体 YouTube 内部根因。

当前探针另提示部分 mweb HTTPS 格式缺少 URL，只有 format 18 可选；这与上游记录的 [mweb SABR 格式限制](https://github.com/yt-dlp/yt-dlp/issues/17666) 相符，但该现象本身不能证明此次失败原因。保留现有 progressive HTTPS 选择器及重试预算，不新增纯格式错误的自动快速重试，也不为本次事件切换 DASH、鉴权或出口。

## 定向运行恢复

原 feed 的正常下一次更新为 22:21:54。确认同参数提取已恢复后，通过现有配置热刷新提前安排一次原 feed 更新：

1. SELECT 锁定原事件及 feed，确认 A 尚未发布、feed 启用且周期为 1h。
2. 21:38:40 使用 feed、原周期和 updated_at 的比较并交换条件，将唯一目标 feed 的周期暂改为 59m。现有调度器只为变更周期的 feed 重新入队。
3. 21:41:56 观察 NAS 接受临时周期；21:41:58 使用临时值及 updated_at 条件恢复权威配置的 1h，除 updated_at 外 feed 各字段与操作前一致。21:46:56 确认运行时也恢复 1h，基础配置和远端配置缓存的 SHA-256 与操作前一致，一份源 Bilibili Cookie 的 SHA-256 一致。恢复周期使该 feed 再扫描一次，A 实际只启动一次下载，未重复下载。

比较并交换避免覆盖并发配置变更；等待热刷新有六分钟上限，异常路径同样执行回退。未手写媒体或节目状态，未删除错误历史、清空队列、打开运行中 Badger 的第二个实例或触发全量同步。生产应用仍运行 `6521832`，未重建或重启 Podsync/provider/媒体 Tunnel 容器；三者 RestartCount 均为 0。仓库基线为 `0c1a9d0`，应用版本与仓库文档版本分别核对。

## 验收记录

截至 21:59:34，按原 feed/episode 身份关联 NAS、D1、RSS GUID、源链接和媒体文件，验收通过：

| 时间 | 原集及服务读回 |
| --- | --- |
| 21:41:58 | A 的定向真实下载开始 |
| 21:50:30 | 下载、MP3 转码完成；D1 记录 episode_download_finished |
| 21:54:40 | 内部 `/health` 为 HTTP 200/healthy，当前失败数为 0 |
| 21:54:59 / 21:55:00 | A 的 episode_upload_finished / episode_report_finished；D1 为 visible |
| 21:55:27 | 公开 RSS 200，恰有一个 A 的 GUID；源链接、enclosure MIME/大小与 D1 相同；媒体 HEAD 200，大小一致 |
| 21:55:34 / 21:55:36 | Mac / NAS 唯一查询参数 Range 均为 206、1024 字节、MISS，总长度 29,036,364，两侧返回内容一致 |
| 21:57:51 | nginx 已有对应两次唯一查询的源站记录，均为 200、29,036,364 字节；客户端收到 206 切片，不要求源站也返回 206 |
| 21:59:25–21:59:28 | Worker 在两侧均 200/ok；未认证 dashboard 302 至 Access；媒体 healthz 204；原集经 Worker → Access → Tunnel → Podsync 的只读管理 HEAD 检查为 204 |

恢复下载摘要为 success、attempts=1、format_id=18、audio_codec=mp4a.40.2、protocol=https、last_stage=complete；总耗时 512563 毫秒，等锁为 0，29456 字节诊断输出未截断。原视频为 103,050,940 字节；发布 MP3 的 NAS 文件、D1、RSS enclosure 和公网 HEAD/Range 总长度均为 29,036,364 字节。ffprobe 检出 MP3、44.1 kHz、双声道，2952.928073 秒，源记录为 2953 秒。

健康接口的零值 `failed_episodes` 使用 `omitempty` 省略；healthy 分支仅在失败计数为 0 时返回 200。没有删历史错误来消警：从 21:22 至验收仍只有原来的一个最终下载失败事件，A 的后续下载和发布确认均保留；当前状态为已恢复。

21:59:34 最近运行轮次从 21:30:01 开始，仍为正常小时窗口内的 running，feed/下载/上传为 2/1/1、errors_count=0；最新事件为 21:56:55。20:29:00–21:29:59 的上一轮保持 partial、28/1/2、错误 1；再前一轮保持 success、43/3/3、错误 0。没有提前把当前 running 写成 success。配置、缓存及源 Cookie 的一致性于 21:59:33 再次确认。

本次验证包含完整生产下载/转码和发布、源站媒体大小/音频流及公网首个 1024 字节切片；没有执行完整公网客户端下载或整段音频解码。当前交付没有阻塞；失败时上游具体处理状态仍受前述证据缺口限制。

## 其他证据与验证范围

- Go 1.27.2 下，调度器变更/恢复周期、未变更 feed 不重复入队的聚焦测试通过；下载管理器关于纯格式错误、TLS 恢复、耗尽仅记一次失败及独立重试信号的聚焦测试通过。没有修改应用代码；按仅文档变更规则检查本地 Markdown 链接、敏感标识和 git diff，无需完整 Go fmt/lint/test。
- 本次开始时已有 Dockerfile、THIRD_PARTY_NOTICES.md、Compose PO token overlay 和 provider 文档四处未提交改动；生产已通过只读插件挂载及隔离 bridge 使用匹配的 provider 2.0.2。本任务保留这些改动，不纳入本次提交。
- 21 日 13:38:40 至 22 日 00:09:07 的历史 failed 轮次，结束事件为 `previous process stopped before its final event report`，errors_count=0；与持久事件 recorder 在新进程启动时收尾旧 running 状态的代码一致。该已闭合记录未修改；为何旧进程未完成最终上报，没有补造解释。
- 当前容器日志从 22 日约 00:09 开始。重建前昨晚的完整本地日志未取得，不把缺失时段计为零；D1 可覆盖近 24 小时事件。
