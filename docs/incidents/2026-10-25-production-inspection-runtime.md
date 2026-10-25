# 2026-10-25 巡检入口失配、格式失败与进程中断复核

时间使用 Asia/Shanghai（UTC+8）。本次发现的可修复问题是：Podsync 已于 10 月 24 日迁到 Mac mini，日常巡检仍固定访问旧 NAS Docker 和 9091。已更新现有自动化及运行文档，保留每日 08:00、五项完整报告、只读巡检边界、既有派修授权及指定修复模型。未启动 NAS daemon 或旧容器，未修改应用、生产配置或 Cookie，未部署、重启、重跑同步或改写 D1。

## 真实生产与单一写入者

- 当前生产位于 4T 专用 Colima `platform` 环境。使用受守卫的 `docker-platform docker`，不能使用 Mac 默认 Docker context 判断运行状态。
- 唯一 producer 为 `podsync`，镜像 `ghcr.io/kyangc/podsync:nightly`，生产 Compose 固定 digest；当前启动日志确认 commit `6521832`、ARM64、RestartCount=0。
- Compose 在 `/Volumes/4T/DockerData/platform/stacks/podsync`；媒体为 `/Volumes/4T/PublishedMedia/podsync`；Badger 和下载临时目录分别为 `podsync-db`、`podsync-tmp` Linux volumes。
- NAS 停机后磁盘上的容器状态确认：10 月 24 日 12:16:35 退出，ExitCode=0、OOMKilled=false、restart policy=`no`。日志最后记录 `gracefully stopped`。Mac 首次启动为 12:27:53，没有两端 producer 重叠写入的证据。
- 迁移验收文件确认旧 NAS 四容器已停止、媒体和数据库完成最终同步、原订阅客户端播放通过。当前 Mac producer 与该验收记录是同一容器；NAS 当前无 Docker socket、daemon 或 Podsync 进程。
- 08:08:21 内部 `/health` 为 HTTP 200/healthy，最后成功更新为 08:05:59，年龄 142 秒，阈值 21,600 秒。四个 Podsync 服务均 healthy，当前实例及启动时间在核查前后未变。

## 两次 YouTube 格式失败

同一集分别于今日 02:05:20、03:05:17 返回 `Requested format is not available`。两次均只尝试一次，在 extract 阶段结束，耗时约 5.5 / 5.8 秒，尚无选中格式元数据。诊断出现 mweb、bgutil HTTP PO Token 请求及 deno JS challenge；这些文字不足以证明 Cookie 失效、provider 故障、JS 求解失败或直播后处理延迟。

同一集在 04:07:06 成功下载，格式 `18`、音频 `mp4a.40.2`、协议 `https`；04:08:41 上传与 report 均完成，D1 为 visible。源端当时为什么未提供匹配格式无法从现存日志唯一确定；当前已有成功结果，没有可重现的持续失败，因此不修改下载选择、重试预算或 Cookie。

08:00 巡检交接已补齐该原失败集的交付验收：Mac/NAS 两侧公网 RSS 均 200、恰好一个对应 enclosure，媒体均 Range 206/1024 字节，独立查询均 MISS，总长度与 D1 的 64,866,130 字节一致。本次额外核对 Mac 实际媒体同样为该大小，未重下该集或重跑同步。

## 16:03 failed 的真实上下文

这不是计划切换的正常结束事件。迁移聊天与平台事故记录表明，10 月 24 日 15:49:58，内核出现 RTL9210 USB link termination、I/O error 和 4T media-not-present；15:50:01 同一卷重挂载，但 Colima 旧管理与业务接口仍失联。既有迁移工作留存现场后恢复原 VM，当前 guest boot 时间为 16:03:20、Podsync 启动为 16:03:25。

15:30:08 开始的旧轮次最后正常事件在 15:48:41；新进程于 16:03:26 补记 `previous process stopped before its final event report`，保留 failed、errors=0、feed/下载/上传=26/1/1。这与 [durable recorder 恢复逻辑](../../services/remote/events.go) 一致：读取持久状态、补闭合旧轮次、发送确认后再清除对应待发送前缀。未删除或改写该历史记录。

- 08:03 的序号快照覆盖 10 月 23 日 08:00 起 49 轮、5,689 条事件，均从 sequence=1 连续，无内部缺口。
- 同一快照覆盖 10 月 24 日 08:00 起 26 轮，feed、下载、上传、error 事件计数与 run 汇总逐项一致，包括该中断轮次与两轮 partial。
- 中断后已有多个正常轮次闭合。轮次持续轮转及连续序号证明历史事件积压已被确认；不以直接打开运行中的 Badger 作为取证方式。
- 最后一次 Tunnel 启动为昨日 16:05:45，存量 RestartCount=11；日志最后 ERR 在 20:47:58，包含客户端断连和旧控制流取消。当前 `/ready` 为 200、readyConnections=4，HA connections=4，未为清计数而重启。
- USB 断连的物理原因仍未确定。已证实平台故障与进程恢复的时间关系，未证明硬件问题被永久消除；本次不改动共享 VM、网络或其他迁移服务。

## 日志窗口与同步读回

08:00 固定快照覆盖昨日 08:00 至今日 08:00。NAS daemon 已停，本次仅只读复制原容器的三个 Docker local 日志文件，在本地按长度帧和 protobuf 解码，检查每条记录首尾长度相同、完整消费所有归档。归档覆盖窗口起点至 NAS 12:16 停机，Mac 容器日志覆盖 12:27 启动至今；中间为已记录的迁移停写期，不伪称有运行日志。

| 类型 | 08:00 快照 | 补充读回 |
| --- | --- | --- |
| fatal / panic | 0 / 0 | 当前未新增 |
| Bilibili discovery 跳过 | 48（NAS 8、Mac 40），两条节目；昨日 08:21:55–今日 07:05:45 | 08:05 又跳过同两条，合计 50，无新增节目 |
| 下载摘要 | success 14、failed 2 | 08:05 新成功一集，success 15；失败仍为 2 |
| 远端事件上传 / 元数据 / 配置 / tombstone / 本地事件持久化失败 | 全部 0 | 当前未新增 |
| D1 warn/error | episode_download_failed ×2，sync_run_finished warn ×1；feed_update_failed=0 | 无新增类型或次数 |

Bilibili 跳过只在 [discovery 详情返回 -404 的分支](../../pkg/builder/bilibili.go) 记录；今天识别到的仍为同两条。它不是下载失败计数。昨日已验证源不可用、列表残留与 Cookie 有效，见 [10 月 24 日记录](2026-10-24-remote-timeouts-bilibili-unavailable.md)。本次没有重新宣称今天完成了 Cookie 登录探针，也没有永久缓存 -404、删除节目或压制 warning。

08:00 D1 快照为 success 22、partial 2（errors 合计 2）、failed 1（errors=0）、running 1；feed/下载/上传为 700/14/14。前一轮 06:16:41–07:17:41 为 success、28/1/1、errors=0。当前轮次 07:17:41 开始，08:06:01 已完成 28 个 feed，08:05:37 新下载一集；当前 running 有持续推进，不能判为卡死。D1 查询全部为 SELECT，rows_written=0。

08:11 滚动 24 小时读回为 success 21、partial 2、failed 1、running 1，累计 700/15/15、errors=2；success 数减少是昨日 08:04 的旧轮次移出窗口。当前轮次已达 28/1/1、errors=0，新集 08:08:41 完成上传/report，配置与 tombstone 最新成功为 08:09:14。该滚动窗口全部 25 轮再次核对序号连续、四项计数一致，warn/error 类型和次数未增加。

## 修改与验证

- 日常自动化改用实际 Mac/4T 入口，五项中的历史“NAS”行改为“生产实例”；保留原 ID、名称、heartbeat、目标聊天、时间、状态和通知策略。通过应用工具更新后读回本地配置，逐项确认与预期相同。没有新建重复自动化或改动修复权限。
- [维护参考](../agent-maintenance-reference.md#当前生产运行与巡检入口) 增加当前运行位置、只读探针、日志与轮次口径；[旧 NAS runbook](../nas-media-origin.md) 标明历史位置与禁止双写。
- Mac/NAS 两侧 Worker `/health` 均 200/ok=true、媒体 `/healthz` 均 204，未认证 `/dashboard/` 均 302 至 Cloudflare Access。
- 核查期间 08:08:41 又有真实新集发布，大小 19,440,346 字节。Mac/NAS 两侧 RSS 均 200，恰好一个匹配 enclosure、长度等于 D1；同一检查参数的媒体 Range 均 206/1024 字节、总长度匹配，Mac MISS、NAS HIT。本地文件大小也匹配；nginx 访问日志确认完整源站传输完成，未把两侧缓存状态误写为都 MISS。
- 事件持久恢复、确认后序号延续、上传失败保留 pending、定时轮次轮转四项聚焦 Go 测试通过。仅文档和自动化变更，无应用代码变更，未执行全量 Go fmt/lint/test。
- 文档相对链接、Markdown diff 与敏感信息检查通过。原四处未提交改动及生产配置、源 Cookie 哈希保持不变；私密诊断材料结案时清理，迁移原始证据保留。
