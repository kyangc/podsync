# 2026-10-31：新增固定 ID 观察超时的补充复核

时间为北京时间（UTC+8）。这是 [08:12 结案](2026-10-31-recovered-download-and-control-timeouts.md)
之后的新控制面事件；早间 10 条 D1 error 和单次 NAS TLS 失败继续保留原结论，未重新派单或重跑业务。
本轮有限复核后确认自动恢复，无当前必须修改的代码或运行配置，未重启、部署或执行空间清理。

## 新事件与后续锁等待

恢复器 `inspection_incidents` 从 51 增至 52。新增原记录为：

- `first_at`：09:20:44.214898。
- `last_at`：09:21:01.002565，累计 `timeouts=2`。
- `reason`：`fixed-ID inspection observer timed out`。
- `resolved_at`：09:21:08.428190。

此原因来自宿主暖驻观察器在原三秒预算内未收到固定 ID 的完整 Docker 观察回复。
实际读取通过受守卫 wrapper 的 Unix socket GET，不是已确认的 SSH 写入超时。
按既有流程先撤租、进入 checking，再核验原消费者会话、介质 I/O 和租约后恢复 ready；
没有达到三次未知的 blocked 门槛，没有新建媒体传输或重启消费者。

后续 09:47:05–09:55:56、11:16:26–11:16:30、13:24:10–13:24:24
属于独立的共享维护锁等待及重新验证，不能将 09:20 之后整段描述成持续阻塞。
13:26 快照锁等待记录共 20 条，ready_since 已为 13:24:24，观察事故仍为 52 条。

## 同窗证据与未知边界

09:19–09:23 的宿主 unified log 中，09:20:38.217117 开始出现 APFS lowdisk 通知，
紧接 09:20:39 的系统自动 purge，覆盖两次观察超时；相关记录延续至 09:22:17。
`diskutil info` 确认日志中的 `disk3s5` 是内置 `/System/Volumes/Data`，也是平台 runtime 所在卷。
这是新的同窗宿主空间压力证据，不是旧 USB 失盘或昨日 OOM 的重复归因。
没有观察器原分段计时或对应请求堆栈，无法将延迟唯一定位到宿主调度、守卫、
Unix socket、Docker API、VM 调度或回复读取，也不能仅凭时间接近证明自动 purge 导致超时。

按明确 UTC 边界读取的 guest kernel、Docker unit 和 warning journal 在目标窗口无条目；
日志保留范围跨越该窗口，仍不能将无条目冒称所有调度延迟均被排除。
未取得本次同窗新增 global OOM、USB 断连或其他媒体恢复器同类事故证据。
当前 swap 有效；13:29 左右宿主可用空间约 22.3 GiB。空间清理由另一既有任务负责，
本轮没有清日志、预算、状态、媒体或缓存，也没有向该任务发起未经授权的操作。

原 09:19–09:23 的 `timing.jsonl` / `timing.previous.jsonl` 已轮转。
13:26 留存的两段仅覆盖 13:06:20 起，不能据此否认早间确实发生的两个超时。
新事故状态、宿主目标窗口、guest 目标窗口和当前日志均已保存到受限证据目录。
未找到新的 `probe-failures.jsonl`，没有取得本次媒体写探针失败证据；不将其当作已知成功重放。

## 当前验证及结论

通过原 `Inspector` 和登记的 wrapper/固定容器 ID 做 20 次同观察器读取及 5 次新观察器读取，
最终一组将新观察器创建和指纹核验一并计入原三秒预算，每轮新建 Unix 连接；25 次全部通过，
中位 7.249ms、最大 73.088ms，已关闭诊断子进程。
这是当前只读路径的有限检查，未复现原超时，也没有注入负载、扩大期限或改变门禁规则。

13:27 生产读回为 ready、observation_streak=0、inspection_incidents=52，
两个实际 v2 gate 通过，完整 nonce ACK、boot ID、generation 和原十秒 wall/BOOTTIME TTL 有效。
两个消费者 running/healthy、RestartCount=0，原 ID/指纹及 10 月 30 日 09:27:43 的 StartedAt 不变。
实际应用仍 `63525c0`；Compose、登记、制品、源配置/Cookie 哈希、mtime 和只读绑定吻合原基线。
固定 NFS 根有效、唯一控制器和 Badger writer 保持，Tunnel/provider healthy，内部健康通过。
13:30 再读事故数仍为 52，双门禁、完整 ACK/双时钟、制品和源配置/Cookie 均再次通过，
应用最近一次完整 feed 发布成功时间已推进到 13:30:35。

13:24–13:26 日常巡检已独立读回：08:12 后 D1 无 warn/error，140 次 feed 成功、
3 次下载/发布/上报成功，63 次配置获取、126 次删除标记同步成功；六轮序号及累计计数一致，
SELECT 的 rows_written 均为零。stdout 无新增 error/fatal/panic 或远端上报告警。
两个最新自然发布节目共四组 Mac/NAS RSS 和原地址 Range 均通过，大小、唯一 enclosure 与 D1 一致，
Worker/media 健康及 Access 均正常。此处复用该次只读证据，未手动重跑同步或旧失败样本。

当前没有用户业务故障或必须部署的修复证据。按自动恢复、有限验证结案，保留原因尚未唯一定位的边界；
不因降低告警数量而放宽观察、租约、发布、SSH 或未知写入规则。本轮仅变更文档，
检查 Markdown 链接、敏感信息及 git diff；未改 Go 或平台代码，无需重跑完整应用测试。

受限证据：`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-inspection-timeout-20261031/`。
