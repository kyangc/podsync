# 2026-10-26 生产中断、恢复与巡检证据边界

时间均为 UTC+8（Asia/Taipei）。本次已验证原生产恢复、旧轮次闭合及恢复后两集真实交付，没有发现需要修改 Podsync 代码、配置或凭据的问题。本线程没有启动、重启或部署生产服务，没有重跑同步或补数据；共享平台的恢复由 Monga 修复线程执行。

## 中断与恢复原因

- 10 月 25 日 23:24:24.987，macOS 内核记录 RTL9210 USB link termination；23:24:25 出现 4T 的 I/O error、media-not-present 和 APFS 非正常卸载。23:24:28 同一卷重新挂载。此次是新的系统事件，不是沿用 10 月 24 日的故障推断。
- 平台恢复证据记录 VM 的 Virtualization 服务于 23:24:25.696 退出；旧 hostagent 仍在，但管理 socket 拒绝连接，原自动启动器无法恢复。迁移聊天在昨晚 23:25–23:27 也已观察到 Docker 管理面失联。
- 今早 Monga 修复线程核实 VM 已退出，保存现场，于 08:03:41 仅向确认身份的遗留 hostagent 发送正常 SIGINT，再通过原 `docker-platform start` 恢复同一实例。没有新建 VM、重置数据或使用 SIGKILL。本线程只读核对其恢复记录，没有竞争操作共享平台。
- guest 当前日志始于 08:03:45；Podsync 容器 StartedAt 为 08:03:56，应用于 08:04:06 启动，媒体 Tunnel 于 08:04:33 完成连接注册。初始巡检的 socket 缺失、宿主 9091 连接失败和媒体 healthz 530，与这次平台中断相符。

USB 断连的物理原因仍未确定。挂载恢复、文件系统检查返回 0 和业务验收不能证明硬件问题已永久解决，也不能证明全部持久数据均已完成完整性审计。本次没有修改共享磁盘、VM、时钟或网络配置。

## 唯一写入者与运行版本

生产为 [部署约定](../../DEPLOYMENT.md) 中的 4T `platform` 环境，原 `podsync` 是唯一 producer，四个 Podsync 服务均 healthy。应用启动日志确认 `8009e2f`、nightly、arm64，Compose 固定镜像 digest；不能用昨日的 `6521832` 代替现场版本。

08:10 的 NAS 只读检查确认：没有 Docker socket、dockerd 或 Podsync 进程。NAS 仅用于公网客户端验收，没有启动退役实例。当前 producer 的容器身份、镜像、StartedAt 和 RestartCount 在本线程核查前后保持一致，源配置及 Cookie 内容哈希也保持一致。未打开运行中的 Badger，没有清队列、删历史错误、改媒体或迁移文件名。

RestartCount=0、OOMKilled=false 只描述当前容器状态。可见日志仍有三次应用启动：昨日 16:20:43、17:11:45，以及今日 08:04:06，均为 `8009e2f`。昨日 17:05:48 有 `gracefully stopped`，对应平台留存的 6 → 8 GiB 内存调整及 17:11 原 VM 停启验收；不能将这些启动全部归为昨晚的意外中断。

## 轮次、事件与恢复后发布

中断前最后一个正常完成轮次为昨日 22:15:58–23:16:57：success，feed/下载/上传为 28/2/2，errors=0。随后 23:16:58 开始的轮次最后正常事件为 23:22:46；新进程在今日 08:04:06 补记 `previous process stopped before its final event report`，将旧轮次闭合为 failed，计数 0/0/0、errors=0。保留该记录，不将它解释为节目失败。

最后正常事件至恢复事件的空窗为 8 小时 41 分 20 秒。系统失盘与 VM 恢复有独立证据，但这个上报空窗不是公网全部不可用时长：Worker 仍可返回 RSS，已缓存媒体的历史可用范围没有连续探针，不能倒推。

08:22 读回结果：

| 项目 | 结果 |
| --- | --- |
| 当前轮次 | 08:04:06 起仍为 running，28/2/2、errors=0；没有提前改称 success |
| 新两集 | 08:05:55 前下载完成，08:09:19 上传、08:09:20 report 完成，D1 均 visible |
| 持续推进 | 配置及 tombstone 成功事件已推进至 08:20:00 |
| 序号和计数 | 按 started_at 从 10 月 24 日 08:00 起，45 轮、4,977 条事件；每轮 sequence 从 1 连续，四项事件计数均与 run 汇总一致 |
| 滚动近 24 小时 | 16 success、1 failed、1 running；feed/下载/上传合计 476/12/12、errors 合计 0 |
| warn/error | 仅新进程补闭合旧轮次的 `sync_run_finished` warn ×1；无 feed、下载、上传或 report 失败事件 |

固定按昨日 08:00–今日 08:00 的 started_at 选择旧轮次，在本次恢复后读回为 17 success、1 failed，476/10/10、errors=0。滚动窗口少一个 success 是旧轮次移出窗口；新轮次又包含恢复后的两集。按 event_time 统计跨轮次上传与按 started_at 统计 run 不是同一口径，本次以逐轮计数核对为准。

[事件恢复实现](../../services/remote/events.go) 会先发送恢复轮次，收到确认后才删除对应待发送前缀。旧轮次闭合、后续序号连续和新发布已确认，支持历史事件恢复已推进；没有直接检查全部 outbox 或宣称任意瞬间 pending 必为 0。

## 媒体交付与额外瞬时超时

08:11–08:20 的追加验收曾出现媒体域名请求在 TLS 握手后无响应：Mac、NAS 的初次 Range 均超时，随后 NAS 先恢复，Mac 的媒体 healthz 和既有媒体也曾超时。同期 Worker 正常，容器内两集 nginx Range 均为 206/1024 字节，本地 `.remote-media` 文件大小匹配 D1、链接数均为 2；nginx 也记录了完整源站返回。

只读核对确认 Tunnel 有四条 ready connections。最终日志读回补到 08:15:59、08:16:33 两次 `unexpected EOF`，每次两行 ERR，共四行；后续至结案未再出现。Mac 普通规则匹配与固定公共 A 记录的诊断请求均曾超时，不能将问题直接归为旧 Fake-IP 缓存。单次 DIRECT 路径探针成功，随后普通 Mac 路径也恢复。本线程没有切换出口、刷新 DNS、改 Surge 规则或重启 Tunnel；现有证据不足以唯一定位这段瞬时网络异常，不能把恢复归功于未实施的修复。

约 08:20–08:21，Mac 和 NAS 使用普通网络路径、各自独立查询参数，完成恢复后两集的公网验收：

| 检查 | 两侧结果 |
| --- | --- |
| RSS | HTTP 200；每集恰好一个对应 enclosure，length 与 D1 一致 |
| 新集一 | 4,146,578 字节；Range 206、1024 字节、MISS，总长度匹配 |
| 新集二 | 25,197,740 字节；Range 206、1024 字节、MISS，总长度匹配 |
| Worker / 媒体健康 | 200/ok=true；healthz 204 |
| Access | 未认证 dashboard 302 至 Cloudflare Access |

没有执行整集客户端下载。08:22 容器内 `/health` 为 200/healthy，最后 feed 更新时间 08:06:09，年龄 968 秒，阈值 21,600 秒。08:25 两侧对两集再次以独立参数重复上述全部交付检查，均通过；宿主 9091 为 healthy、更新年龄 1,145 秒，配置及 tombstone 事件已推进至 08:25:00。验收结合实际交付，没有只以 health 200 结案。

## 日志覆盖与 Bilibili

当前容器日志覆盖昨日 16:20:37 至今日 08:20，29,218 行，包含上述停启间断；可见段 fatal/panic=0、下载摘要 success=9/failed=0、远端配置/事件上传等失败=0。warn/error 仅 18 次 `skipping unavailable Bilibili episode`，涉及两个内部标识，最后一次在 08:05:07。该日志分支仅在 [discovery 详情返回 -404](../../pkg/builder/bilibili.go) 时使用，不是 18 集下载失败。

已补查旧 producer 元数据、原 Docker 容器目录、Podsync 迁移/插件修复/发布证据及先前诊断目录。旧 producer 已被重建，其 Docker 日志目录不存在；仅找到昨日 13:49–14:24 的 8 条筛选错误摘录，没有取得昨日 08:00–16:20 的完整应用日志。因此不能声称完整 24 小时 fatal/panic 或所有运行日志错误均为 0。D1 的连续事件也不能补成完整应用日志。

当前两个 Bilibili 标识已在可见日志内逐条去重；留存历史材料不足以完成与 [10 月 24 日已知两条源](2026-10-24-remote-timeouts-bilibili-unavailable.md) 的全量标识对照，不因数量相同就断言完全相同。没有新的下载失败或持续远端错误依据，不修改 Cookie、不永久缓存 -404、不删节目或压制 warning；今天也没有重新执行 Cookie 登录态探针。

## D1 瞬时 API 错误与变更范围

巡检首次聚合查询的 Cloudflare API 7403 由交接保留；随后巡检及本线程的简短、聚合、逐轮核对和交付样本查询均成功，所有查询都是 SELECT、rows_written=0。本线程未重现 7403，没有证据要求更换账号、凭据或重新授权。此前 Worker 遥测 403 是另一权限边界，不能混为本次故障。

本次仅记录事故证据及维护链接。未修改应用代码或生产配置，不适用完整 Go fmt/lint/test；检查文档相对链接、Markdown diff 和敏感信息。原始只读证据和成功、失败探针保存在 4T 的 `DockerData/platform/artifacts/podsync-inspection-20261026`，目录及文件限制本机用户访问。当前生产恢复与两集交付已验收，剩余限制是 USB 物理原因未明、旧完整日志缺失，以及追加媒体瞬时超时的唯一原因未定位；不宣称这些问题已被永久消除。
