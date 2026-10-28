# 2026-10-28：媒体租约慢发布后的永久阻塞

本文时间均为北京时间（UTC+8）。本次修复延续每日巡检派修授权；
原 10 月 27 日 inspect 超时修复见[昨日记录](2026-10-27-media-recovery-and-migration-dns.md)。

## 现场与可复现原因

08:06 刷新现场时，四个 Podsync 服务仍在运行，但恢复器确实 blocked，
Linux `/run/platform-media-lease/lease.json` 不存在，两个消费者的原门禁入口均返回 75
（宿主 Docker wrapper 返回 1）。现有进程可以读取媒体，不能证明重启能够重新准入。

阻塞发生于 10 月 27 日 19:13:17，晚于昨日 11:36 验收；其前一次 ready 为 19:00:11。
原因是 `guest lease publication was too slow`，不是旧 inspect 阻塞记录。
已按控制器规则核验 activation/config 哈希、全部制品、两个容器 ID 与完整配置指纹、
介质 UUID、同一 generation 的两个会话证明、传输父子关系，以及介质 I/O/硬链接探针。
它们均有效，自动 attempts=[]，原 reviewed_blocks、维护许可消费和 17 次观察事故仍在。

旧 `grant()` 先通过 SSH 在 Linux 内写入、fsync、原子替换租约，再检查整个调用耗时。
只有 SSH **成功返回**且总耗时超过两秒时，才抛出上述明确原因；
SSH 三秒超时或非零退出是另一条结果未知的路径。主循环把这次已确认完成、随后已撤租的
慢发布当成永久阻塞，后续健康观察不会再准入。

聚焦测试直接经过真实 `run_once → tick → grant`，在临时目录执行实际租约写入代码，
注入 2.1 秒已确认发布。修改前稳定复现 `ready → blocked → blocked`；
修复后为 `ready → checking → 全量重验 → ready`，checking 时租约不存在。

历史单次延迟的唯一底层触发源无法定位：当前 18 次同一 SSH 只读调用为 0.076–0.200 秒，
宿主与 guest 时差约 6–9 毫秒；19:10–19:19 的电源记录没有 Sleep/Wake 转换。
guest journal 有 SSH 会话记录，但没有该次发布的分段耗时。不能据此归因时钟、USB、共享锁
或某个具体通道。新增异常会保留实际耗时、确认状态和恢复时间，供复发时核查。

## 最小修复与交接

平台恢复器增加专门的 `LeasePublicationSlow` 分类，不改变两秒发布预算、三秒 SSH 时限、
Linux 十秒 TTL、门禁二进制或连接预算：

- 仅原 owner 已准入、传输仍存活的会话允许有限重验，慢发布一律撤租。
- 最多三次，退避一/三秒；每次重新校验 activation、制品、容器指纹及原 StartedAt、
  介质身份、generation 与新 I/O 探针后，才尝试新的正常发布。
- 单独记录 `lease_publication_incidents` 与连续计数；成功完整准入后结束事故。
- SSH 超时、非零退出、首次准入、消费者会话改变、制品漂移或未知 writer 结果仍阻塞。
  三次慢发布也阻塞；不启动消费者、不新建传输来重试这一观察路径。

平台 35 项恢复器测试通过，包含上述恢复与拒绝边界；显式 `scripts/check_local.py`
的 22 条本地检查通过，含 40 项 internal-storage 测试。未自动执行历史迁移工作负载。
Podsync 应用没有代码变化，不适用完整 Go 测试。

08:10:03 对两个已登记消费者正常发送 TERM，均退出 0、无 OOM；
原传输仍存活时正常卸载闲置 NFS 并恢复只读占位。
只在锁边界暂停本服务 owner，排空期间不持共享 runtime 锁。
登记阶段第一次遇到锁竞争后安全退出，核对消费者已正常退出与占位挂载后继续登记；
未操作其他媒体恢复器或其锁。08:10:48 重新登记原 LaunchAgent，
08:10:52 原两个容器由控制器启动，08:10:53 ready。维护停写约 49 秒。

实际制品目录为 `runtime/control/media-recovery-podsync-lease-20261028/`。
原 blocked 的完整 state 嵌入新增审查记录，另有维护交接回执；保留原历史、预算与已消费许可。
本次传输连接由原控制器记账，没有手造 lease、删队列/错误、清预算或重放业务任务。
应用镜像、门禁、NFS 后端及动态库未改；容器 ID、Compose、只读源配置和 Cookie 内容保持。
新进程启动日志实际 commit 为 `56d8a66`、nightly/arm64。Cookie 源文件 mtime 未变，
宿主与 Linux 容器内容哈希一致；其只读源挂载保持。

## 持续准入与业务读回

早期观察的 08:12:09 出现一次三秒只读 inspect 超时，租约正确撤销，两个真实门禁返回 75。
08:12:13 原控制器自行重验恢复，事故记录 resolved，消费者 StartedAt 未变。
维护中尚未签租、首次 connecting 的样本和这次 checking/拒绝均分别留档，不能称为全程绿灯。
恢复后 08:13:33–08:23:33 的连续十分钟共有 121 次五秒采样，全部 ready、Linux 租约有效且 generation 匹配；
11 轮双消费者真实门禁共 22 次全部通过，消费者 StartedAt 未变。
原控制器按既有十分钟稳定规则自行恢复当前连接预算；本线程未清预算，本次连接记录保留在采样与登记回执中。
早期 inspect 事故仍为 18 条（新增一条已解决），稳定窗口没有新增慢发布事故。
最终租约剩余 10 秒、两个会话证明一致，介质 I/O/硬链接探针再次通过。
完整旧 blocked 与维护许可消费记录逐字段保持；部署源码与已测试源码逐字节一致。

两个限流原样本及巡检最新发布集的源媒体大小分别为 9,430,945、16,024,399、28,429,392 字节，
容器读回均与 D1 一致，硬链接数均为 2。容器经实际 `media:8080` 的 Range 均为
206/1024 字节，总长度正确，内容 SHA-256 与源文件前缀一致。
初版验收脚本误用 80 端口，连接拒绝证据保留；改用实际 nginx 配置的 8080 后通过。

交接后 Mac/NAS 六次 RSS 均 200、各恰一个匹配 enclosure，长度与 D1 一致；
六次原地址 Range 均 206/1024 字节、总大小正确、内容与源文件前缀一致。
Mac 两个旧样本 HIT、最新集 MISS，NAS 三集 HIT；没有叠加冷参数请求。
Worker 200/ok=true、媒体 healthz 204、未认证 dashboard 302 至 Cloudflare Access 均通过。
Mac 本次媒体 healthz 耗时 29.646 秒，NAS 0.766 秒，保留该延迟。
巡检先前第二个原样本 Mac curl 28、08:06 普通地址复验成功的事实也保留；
这些瞬时公网延迟没有唯一归因，不能用最终成功覆盖失败。

## 新远端超时与事件确认

本次取得同一容器 10 月 27 日 08:00 起的连续日志，跨受控停启保留。
五次配置刷新、一次 metadata upsert、十五次事件批次上报和六次 tombstone 请求失败
均为 `context deadline exceeded`。对应路径分别是 `/api/nas/config.toml`、
`/api/nas/feed-metadata/upsert`、`/api/nas/events/batch`、`/api/nas/tombstones`；
没有这些错误包含昨日的 `server misbehaving` DNS 证据。

D1 新增 error 为配置 5 + tombstone 6 = 11，fallback 5 为 warn，
上报重试日志 15 条不能再加到 errors_count。两轮受影响记录为：

| started_at—finished_at | 状态 | feed/下载/上传 | errors | 事件与序号 |
| --- | --- | --- | ---: | --- |
| 10/27 19:10:54—20:11:53 | partial | 31/2/1 | 1 | 130 条，1–130 |
| 10/28 02:17:54—03:18:53 | partial | 28/0/0 | 10 | 115 条，1–115 |

最后配置失败 02:45:55 后，02:50:25 配置已成功；tombstone 02:46:10 起已后续成功。
08:12 再查 46 轮、5,793 条事件，每轮 sequence 连续、无重复，四项累计计数和状态相符。
上报实现仅在成功确认后移除持久待发前缀，受影响轮次已闭合、之后轮次持续推进；
这些证据支持确认已经推进，不据此断言任意瞬间 outbox=0。

本轮排空前的 run 于 08:10:03 正常闭合 success、0/0/0、errors=0。
新进程 run 于 08:10:52 开始，28/0/0、errors=0；28 个启用 feed 的 metadata
均推进到 08:10–08:11，配置、tombstone 和上报也已恢复。
所有 D1 请求只执行 SELECT，逐次验证 rows_written=0；未打开运行中 Badger。
当前没有需要强制同步、补数据、重启共享网络或改超时预算的证据。
历史远端请求停滞的唯一传输原因仍未定位，不套用旧 DNS 故障结论。
当前 Tunnel 4 个有效连接、在途请求 0；累计请求错误 2 保留，不清零。
现场还观察到 HotTracker 身份变化与四个 Monga 消费者停启，单独记录在并发变化清单；
本线程脚本只操作已登记 Podsync 消费者，未更换 Monga 的控制器或登记。

## YouTube 与 Bilibili 口径

10 月 27 日 15:14:12、15:14:48 的两次 429 分属两期节目，
每期的 youtube-dl error、summary 和限流 warning 是同一次尝试，不能算六次失败。
`ytdl.Download` 在发现实际 429 后返回 `ErrTooManyRequests`，
updater 在记录终态 DownloadFailed、失败 hook 和 EpisodeError 之前直接结束本批下载，待下一轮重试。
所以本地 summary=failed 与 D1 download_failed=0 可以同时成立，不是已证明的丢事件。
该 sentinel 未携带 SummaryProvider，摘要的 metadata=false、output_bytes=0、阶段 unknown
表示这条错误路径缺少诊断字段，不能据此断言 downloader 没有执行或无真实输出。

两期随后于 16:14:36、16:15:18 下载成功，16:18:19 report，当前 visible。
本轮已核对真实源媒体、D1、双侧 RSS/enclosure 与 Range，未重下或重跑同步制造成功。
同一容器完整日志共 111,259 行，始于 10/27 00:06:06；逐项比较 10/27 08:00 前后
的 Bilibili unavailable 标识集合，实际相同两条（此前 16 次、之后 52 次，含本轮启动）。
重启后取得 3,270 行应用日志，error/fatal/panic 均为 0。
未修改 discovery、Cookie、节目或 warning 等级。

受限原始证据、失败探针、完整登记前后状态、持续租约与交付读回保存在
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-lease-recovery-20261028/`。
回退须沿用[部署约定](../../DEPLOYMENT.md)正常排空、卸载和重新登记，不能直接启动旧 4T VM。

## 最终结案读回

08:23:34 的两个消费者均 healthy，真实门禁通过；内部最近 feed 更新年龄
705 秒，阈值 21,600 秒。
最终 D1 复核 46 轮、5,803 条事件，逐轮序号、去重和四项计数吻合；
新 run 仍 28/0/0、errors=0，最新控制事件 2026-10-28T00:21:19Z（UTC）。
两期限流原样本与最新集的 Mac/NAS RSS、enclosure 长度和 Range 再次全部通过，六次均 HIT，
1024 字节前缀与真实源文件一致；Worker、媒体 healthz 和 Access 均通过。
Mac 媒体 healthz 复验 0.808 秒，保留先前 29.646 秒延迟；Tunnel 在途 0、有效连接 4、累计请求错误仍为 2。
没有通过生产慢写注入、拔盘或整机/VM 重启验收；本次本地故障复现与有限生产观察不代表所有未来故障均可恢复。

平台修复以 `9b39848` 聚焦提交并推送，提交中的控制器与实际部署制品逐字节一致。
