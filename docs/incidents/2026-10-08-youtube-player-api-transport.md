# 2026-10-08 YouTube 播放器 API 传输失败与正常调度恢复

生产状态快照截至 2026-10-08 08:58:51，时间均为北京时间（UTC+8）。本文用 A 代替节目身份，不包含 feed/episode/run 标识、订阅或媒体完整地址、Cookie、Token。相关既有修复见 [10 月 7 日事故记录](2026-10-07-youtube-download-transients.md)。

## 结论与处理决定

今早新增失败的 A 已通过 `0e893b1` 的正常调度恢复，08:45:59 下载完成、08:48:12 上传并确认发布。公开 RSS、对应媒体大小、Range 响应和 NAS 上的音频流均已读回验证；08:58:19 内部健康为 200/healthy。

三次失败均在获取 mweb 播放器 API JSON 时耗尽内部重试，终态为 TLS 握手超时；前两次另含 EOF。播放器数据未取得，随后只剩图片格式，才出现 `Requested format is not available`。这是已证实的失败链条，不能仅凭末尾文案认定格式配置错误。三次尝试不等于三集失败：本次只有一集、一次最终失败事件。

现有外层分类、三次尝试上限和 5 秒/30 秒退避均与日志一致。完整失败输出在真实下载管理器调用路径中回放通过，没有发现遗漏重试、提前写最终失败、成功后继续重试或错误计数扩大的应用缺口。因此事故复核阶段只补充记录，不修改代码、格式、重试预算、鉴权、出口或告警，不需要部署。随后授权的本地可观测性优化单列在文末，不用于解释此前的生产恢复。

传输波动仍会重复发生，但具体网络根因未定位。当前 DNS 仍进入 fake-IP 段；未取得故障时刻的网关规则命中、实际出口节点和上游连接日志，不能确定是某个代理节点、代理上游连接还是 YouTube 边缘服务。

## 失败、恢复与公开交付

以相同 feed/episode 身份关联 NAS 日志、D1 事件、D1 episodes、RSS GUID、源资源地址和 enclosure；D1 的 source/local 身份也一致。

| 时间 | 已观察事实 |
| --- | --- |
| 07:44:16 | A 被发现并进入下载 |
| 07:45:24 | 第一次尝试失败；TLS/EOF 后播放器 API 获取失败；外层记 next_attempt=2、tls_transport |
| 07:46:58 | 第二次尝试失败；TLS/EOF 后播放器 API 获取失败；外层记 next_attempt=3、tls_transport |
| 07:48:45 | 第三次尝试失败；TLS 握手超时后播放器 API 获取失败；D1 仅写一次 episode_download_failed |
| 08:44:44 | 下一次正常 feed 调度重新发现并下载 A |
| 08:45:59 | episode_download_finished；NAS 记录下载成功 |
| 08:48:12 | episode_upload_finished、episode_report_finished；episodes 为 visible |
| 08:56 | 公开 RSS 和媒体验收通过 |
| 08:58:19 | 内部健康 200/healthy；最后成功 feed 更新 08:44:42 |
| 08:58:49 | NAS 媒体大小与音频流检查通过 |

公开验收不是只检查 HTTP 200：

- RSS 为 200，恰有一条匹配 A 的 GUID，源资源与 D1 相同。
- enclosure 为 `audio/mpeg`、28,607,269 字节；媒体 HEAD 为 200，大小/MIME 与 D1 和 enclosure 一致。
- Range `bytes=0-1023` 为 206，实际返回 1024 字节，Content-Range 总长度为 28,607,269。
- NAS 对应 MP3 文件同为 28,607,269 字节；ffprobe 检出 MP3、44.1 kHz、双声道，时长 2735.31 秒，源节目记录为 2736 秒。
- Worker 健康为 200/ok；未认证 dashboard 请求为 302，仍跳转 Cloudflare Access。

这些检查没有下载并逐字节核验整个公开媒体，也没有执行完整音频解码。

公网验收使用 curl。本机 Python urllib 在相同 RSS 地址返回 Cloudflare 1010/403；[官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/) 将 1010 归为客户端签名拦截。这项客户端限制单独记录，未放宽访问保护，也未将其混同为 YouTube 播放器 API 的 TLS 传输故障。

截至 08:58:51，当前启动版本仍只有上述一次最终下载失败。当前同步从 08:03:21 开始，状态 running，feed/下载/上传为 28/1/1、errors_count=0，仍在正常一小时窗口内；该周期尚未完成，不能提前记为 success。上一周期 07:02:12–08:03:12 为 partial、28/0/0、errors_count=1，历史失败保留。

## 完整失败请求链与条件

三段完整 NAS 输出分别覆盖网页、mweb client config 和 mweb player API 请求。关键共同链条为：

```text
Downloading mweb player API JSON
WARNING: The handshake operation timed out. Retrying (.../3)...
WARNING: Unable to download API page: The handshake operation timed out
WARNING: Only images are available for download
ERROR: Requested format is not available
```

第一、二次在此前请求中也记录 `UNEXPECTED_EOF_WHILE_READING`。第三次仍明确包含 TLS 握手超时，因此同样属于已有 tls_transport 分类；没有只凭纯格式错误扩大重试。每次播放器 API 均有初次请求及最多三次 extractor 内部重试，这与 `--retries 1` 的媒体重试属于不同层。

本次未进入选定媒体格式后的下载阶段，不属于 10 月 7 日补丁新增的终态媒体 read_timeout 模式。该补丁没有遗漏这次错误，也不能保证三次播放器请求均失败时立即交付。

读取实际 NAS 启动配置和远端缓存确认：

- A 是 audio/high feed，更新周期 1h。实际追加选择器为 `18/best[protocol=https][vcodec!=none][acodec!=none]`，覆盖默认 `bestaudio`。
- 使用 mweb 和匹配的 BgUtils provider；socket timeout 为 12 秒，媒体/fragment retries 均为 1；每个 yt-dlp 进程上限 30 分钟。
- A 的配置更新时间为 2026-07-09 17:36:43，早于此次故障；没有 Cookie profile、`--cookies` 或浏览器 Cookie 参数。
- NAS 仍运行 `0e893b1`，10-07 10:43:05 启动，RestartCount=0；provider 为 1.3.1、healthy、RestartCount=0，日志驱动仍为 none。

## 格式、音频与鉴权的只读复核

在原 Podsync 容器和网络上，对同一源资源执行一次只读提取。沿用实际下载参数，追加 simulate、skip-download 和禁用磁盘 cache；未传入 Cookie、未下载媒体、未改写配置或源 Cookie。另对比了正常配置加载与 ignore-config 的有效格式、Cookie、extractor、timeout/retry、header/proxy、postprocessor 和路径选项，确认一致。

提取约 5.82 秒成功：

| 项目 | 结果 |
| --- | --- |
| 播放器响应 | playability=OK；32 个上游流，其中 12 个 audio MIME 流 |
| yt-dlp 可用格式 | 13 个含音频格式 |
| 最终选择 | format 18、HTTPS、mp4a.40.2 音频与 avc1 视频 |
| PO Token | 加载 bgutil:http-1.3.1；记录 GVS PO Token 生成步骤，无 provider 错误 |
| JavaScript | Deno 2.7.4 求解成功；EJS solver/core 0.8.0 |
| 传输与鉴权告警 | 本次探针无 TLS/读取超时 warning、HTTP 403、Bot Check 或登录要求 |
| yt-dlp | stable 2026.08.19，与启动版本相同 |

当前同一选择器可以取得含音频的格式，没有持续格式配置或音频缺失的证据。mweb 的 GVS PO Token 与播放器 API 请求属于不同用途，见 [官方 PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)。三次历史错误均在播放器 API 的 TLS 传输阶段结束，没有证据证明 Token/session 拒绝导致失败，也没有据此轮换凭据。

正常成功下载的 yt-dlp 输出未被保留，所以不能声称 08:45 的生产下载一定选择了与探针相同的 format ID，也不能完整还原当时成功请求的 session、播放器版本或出口变化。原始失败播放器 JSON、握手分阶段耗时和具体出口日志也未保存；本次格式/Token/求解器结果描述的是当前探针。

诊断前后，NAS 启动配置和远端配置缓存 SHA-256 均一致，一份源 Bilibili Cookie SHA-256 一致。没有 Cookie 文件被回写污染的迹象。

## 其他波动与网络定位边界

08:58 前的 D1 关联复核确认：

- 八次 tombstone_apply_failed 分别为七次 EOF、一次 TLS handshake timeout；每次 9–23 秒后均有后续 tombstone_applied。这些是已恢复的请求波动，没有作为当前未交付节目处理。
- 03:38 的配置失败使用缓存，03:43:34 恢复 remote_config_fetched；NAS 同时段日志支持 EOF，但 D1 的 fallback 记录本身只标明 cache。
- 两次 feed_update_failed 均发生在昨日 10:37:27，为部署回滚时的 `context canceled`，分别于 10:38:39、10:38:56 成功更新；不能将它们归因于今早出口波动。
- 检查窗口内没有 episode_upload_failed 或 episode_report_failed。

容器未配置显式 proxy 环境变量，探针 Proxy map 为空；YouTube 与 Worker 域名在容器中均解析到 `198.18.0.0/15` fake-IP 段。空 Proxy map 不证明绕过透明代理。不同服务出现相似传输错误是共同出口波动的线索，不足以确认共同具体节点，且这些错误与 07:44–07:49 的失败并非同时发生。

若继续定位网络根因，需要 07:44–07:49 的网关 DNS/规则命中、实际代理节点及连接日志，最好包含 TLS 建连/上游 EOF 或超时记录，并与 08:44–08:46 的成功窗口比较。当前证据不支持盲目放宽格式、增大重试预算、关闭保护、轮换 Cookie/Token 或更换代理配置。

## 本地验证与授权边界

三段完整失败输出脱敏后，通过临时 Go overlay 回放到 [下载管理器](../../services/update/updater.go) 的原始调用路径，复用仓库的 [下载测试设施](../../services/update/updater_test.go)：

- 三段均被现有分类器识别为 tls_transport。
- 原始三段顺序回放产生三次下载调用和恰好一次最终失败，保留第三段错误。
- 分别在每段错误后模拟成功，均产生两次下载调用和恰好一次下载完成，不提前记最终失败。
- 现有下载测试同时通过，包括纯格式缺失/登录错误/非终态读取超时 warning 不扩大重试、非 YouTube 不改变行为、终态读取超时、耗尽只记一次失败和 context cancellation。

检查使用 Go 1.25.8，18 个顶层测试全部通过；其中事故回放另含四个场景。临时 harness 和脱敏输出保留在本次私有诊断目录，未加入仓库或修改生产文件。事故复核阶段代码没有变更，因此按仓库仅文档规则检查 Markdown 本地链接、敏感标识和 git diff，不运行无关完整 fmt/lint/Go 测试。

事故复核没有提交、推送、部署、重启、手动重跑生产同步、补数据、清理或迁移媒体，也没有写入远端 D1。生产恢复由既有版本正常调度完成，不能归功于本次文档更新；该复核阶段没有生成待部署补丁。

## 后续本地可观测性优化

用户随后授权推进前两项优化，本地验证截至 2026-10-08 10:09:31：

- [远端下载错误摘要](../../services/remote/download_error.go) 先完整脱敏，去掉百分比进度行，再按 2048 字符上限保留开头告警和末尾终态错误，避免进度输出挤掉实际失败原因。
- [下载摘要](../../pkg/ytdl/download_summary.go) 和 [管理器日志](../../services/update/updater.go) 记录最终结果、尝试次数、进程及总耗时、最后观察阶段，并按白名单保留可用的格式、音频编码和协议。播放器 client 只记显式配置值。旧下载器不支持分阶段 print 时沿用原参数；缺失提取字段用 JSON null，避免丢弃其他有效元数据。详细字段定义见 [维护参考的日志章节](../agent-maintenance-reference.md#日志)。

Go 1.25.8 下的 `go fmt ./...`、`golangci-lint run`（0 issues）、`make test`（全部 12 个包）及受影响三个包的 race 检查均通过。回归覆盖终态错误保留、Unicode 长度、脱敏、元数据白名单、缺失字段、旧下载器回退、重试恢复/耗尽时仅一次最终事件，以及源 Bilibili Cookie 不被回写。

另通过临时 Go overlay 调用仓库完整下载管理器，使用 yt-dlp 2026.08.19 和 ffmpeg 从本机 HTTP 服务下载合成媒体并保存转码结果。10:09:30 日志为 success、attempts=1、format_id=mp4、protocol=http、last_stage=complete、metadata_available=true；耗时 520 毫秒，数据库状态与下载完成事件均通过断言。ffprobe 读回结果为 9093 字节、2 秒、MP3、44.1 kHz、单声道。该来源未提供音频编码元数据，日志正确省略该字段；没有为补齐元数据改变下载选择器或额外请求上游。

以上仅为本地验收，补丁未提交、推送或部署，也未改动生产配置、格式选择、重试预算、鉴权及媒体。生产是否产生新摘要需要在另行部署后观察，不能由本地命令成功提前认定。

### 继续优化：取消、超时与后台更新退出

截至 2026-10-08 10:26:22，进一步修复了下载器生命周期的两个缺口：

- 下载失败保留执行错误链；取消或达到进程时限时，错误详情明确包含终止原因，无输出时回退为执行错误。管理器优先识别 `context.Canceled` / `context.DeadlineExceeded`，避免旧 TLS 输出触发对已终止进程的重试。普通 TLS、HTTP 403 和终态媒体读取超时仍按既有策略处理。
- [后台自更新](../../pkg/ytdl/auto_update.go) 沿用服务 context，等待和执行更新时均可响应取消；保持启动同步更新及每次更新结束后等待 24 小时的节奏。下载退避取消时，最终摘要保留最近一次尝试的阶段、格式和进程耗时，并增加明确的 `failure_reason`。

修复前的回归测试复现了错误原因丢失、取消/时限错误被重试以及取消后摘要丢失。修复后的针对性检查和 race 检查通过，完整 fmt/lint/12 包测试再次通过，三段历史事故输出的四个回放场景仍通过。真实 yt-dlp 下载管理器于 10:25:36 完成本地合成媒体下载和转码，恰好记录一次下载完成，ffprobe 再次确认 9093 字节、2 秒 MP3。所有改动仍仅在本地，未提交、推送或部署。

### 继续优化：排队取消、子进程清理与输出容量

用户继续授权这三项优化，本地验收截至 2026-10-08 11:08:13：

- [执行入口](../../pkg/ytdl/command_lock.go) 保持串行，下载、playlist metadata 和自更新在等锁期间均可响应 context 取消。下载拿到锁后才准备临时目录和 cookies 副本；摘要增加 `queue_wait_ms`，排队取消时记录 `last_stage=queued` 和零进程耗时。
- [Unix 进程组清理](../../pkg/ytdl/process_unix.go) 在取消和命令返回后终止遗留子进程；管道额外等待上限为 2 秒。回归覆盖了取消父进程，以及父进程以 0/1 退出后子进程仍持有管道的情形。非零退出可能隐藏 Go 的 `ErrWaitDelay`，因此清理不依赖该错误是否可见。Windows 取消时采用进程树终止和父进程终止回退；父进程提前退出后的孤儿清理限制见 [维护参考](../agent-maintenance-reference.md#downloader)。
- [下载输出读取](../../pkg/ytdl/download_output.go) 持续消费 stdout/stderr，诊断文本保留最多 128 KiB，单行解析最多 8 KiB；新增 `output_bytes` 和 `output_truncated`。元数据、HTTP 429 和 YouTube 重试依据独立提取，日志中段被省略也不会丢失分类。discovery JSON 仍完整读取，格式选择器和重试预算保持原值。

修复前，回归分别复现了取消后仍等待锁、子进程管道拖住取消返回、150 万字节输出全部驻留，以及父进程非零退出后遗留子进程。修复后，分块输出、超长无换行、截断中段的 403/TLS/终态读取超时与 429、元数据隔离、完整 playlist JSON 和管理器重试行为均通过检查。Go fmt、lint、完整 12 包测试、相关三个包的 race 检查及历史事故回放通过。Linux/Windows 的下载器测试与完整程序交叉编译通过；运行验证在本地 macOS 完成，未将交叉编译当作目标平台的运行验收。

最终真实 yt-dlp 下载管理器于 11:08:13 从本机 HTTP 服务下载合成媒体，记录 success、attempts=1、last_stage=complete、queue_wait_ms=0、output_bytes=1343、output_truncated=false；进程耗时 555 毫秒。数据库状态及唯一下载完成事件通过断言，ffprobe 读回仍为 9093 字节、2 秒、MP3、44.1 kHz、单声道。工作区改动未提交、推送或部署，生产状态未因本轮优化发生变更。

### 继续优化：服务取消、发现错误和进度过滤

用户授权处理新一轮审查发现的三项问题，本地验收截至 2026-10-08 11:55:45：

- [整批下载取消](../../services/update/updater.go) 在节目处理、存储返回、hook 调用和状态写入等边界检查服务 context。取消或服务时限到期时返回原始原因，不将取消或未开始的节目记为失败、执行对应失败 hook 或改写状态；已经返回的临时文件会关闭清理。单次下载器自己的时限仍按真实下载失败处理，服务有效时继续下一期。
- [playlist metadata](../../pkg/ytdl/ytdl.go) 将完整 stdout JSON 与有容量上限的 stderr 诊断分开。空、损坏、null、非对象或字段类型错误的 JSON 返回明确错误；合法 JSON 可与 stderr 诊断同时存在。执行错误保留错误链和诊断，取消/时限原因优先于旧 429 文本，真实限流行为保持原值。
- [百分比进度过滤](../../pkg/ytdl/download_output.go) 在诊断文本占用容量前丢弃进度行，使大量进度不会挤掉中段传输告警。CR/LF/CRLF、分块前缀和无换行末行均有回归；目标路径、下载错误和其他非百分比行保留。原始字节统计、阶段、429 与重试信号仍观察完整输入，128 KiB 文本和 8 KiB 单行解析上限保持原值。

修复前，三期队列在首期取消后产生三条下载失败事件、三次失败状态写入和三次错误 hook；坏 JSON 返回成功，发现执行取消被丢失或旧 429 文本覆盖；两万条进度挤掉中段 TLS 告警。修复后的对应回归以及原始临时 overlay 回放通过。服务取消的队列仅处理已经开始的尝试，失败事件、状态写入及错误 hook 均为零；已取消服务不会启动首期下载。单次下载时限仍记录真实失败并继续下一期，取消时已返回的 reader 确认关闭。退避取消摘要仍保留最近一次尝试信息。

Go fmt、lint（0 issues）、完整 12 包测试、相关三个包的 race 检查及历史事故回放通过。最后的管理器取消边界调整另通过 update 包 race 检查。Linux/Windows 完整程序和对应测试包交叉编译通过，目标平台运行验收范围仍与上一阶段一致。原始临时取消 fixture 曾在并行检查时超出 2 秒就绪等待；单独重跑取消场景及完整原始回放均通过，正式回归和完整测试也通过。

11:53:54 的真实 yt-dlp 验证额外通过本机 HTTP 合成媒体的 metadata JSON 读取，然后调用完整下载管理器下载并转码。最终日志为 success、attempts=1、last_stage=complete、queue_wait_ms=0、output_bytes=1352、output_truncated=false，进程耗时 492 毫秒；数据库状态和唯一完成事件通过断言，ffprobe 仍确认 9093 字节、2 秒、MP3、44.1 kHz、单声道。全部工作仍在本地工作区，未提交、推送或部署。
