# 2026-10-30：未知媒体探针、内存压力及完整重新准入

本文时间为北京时间（UTC+8）。处理目标为 Mac mini Colima `platform` 的既有 Podsync。
本轮继承巡检派修的代码、配置、受控运行修复及聚焦提交推送授权。

## 现场和证据边界

10 月 30 日 09:17–09:21 巡检发现两个消费者 running/unhealthy、RestartCount=0。
登记身份仍一致，Linux lease 缺失，两个真实入口均拒绝；内部应用健康仍为 200，
同步和公开交付仍有成功证据。因此这是业务可用而控制面阻塞，不能描述成全部业务中断。

控制器在 10 月 29 日 12:19:14、12:19:21 连续两次只读 Docker 观察超时后进入重验，
随后 guest 媒体 I/O 探针的整体 SSH 七秒期限耗尽，12:19:35 blocked。
该探针包含 session、目录枚举、8192 字节写入/fsync、硬链接、rename/read 和 cleanup；
它属于写入结果未知，不能套用只读观察的自动重试或清空预算放行。

guest 原始 journal 显示 12:19:57–59 全局 OOM，systemd 触发 OOM killer，Chromium 被杀。
同一窗口另一个媒体恢复器有连续 Docker API 读取超时。
原 VM 无 swap，12:37 已由独立平台修复在内置盘启用固定 4GiB swap；本轮读回有效，
自启用后未见新的全局 OOM。本轮没有重复分配 swap 或修改共享内核、VM、网络、时钟参数。

这些证据确认资源不足窗口及跨服务控制调用停顿，但原探针分段日志已被 blocked 周期轮转覆盖。
目标窗口 journal 中最近的 Podsync sudo 探针为 12:19:00.600–00.691；
没有找到未知调用的对应 sudo 执行记录。这不能证明它从未执行，也不能唯一定位到宿主调度、
SSH、guest 调度或实际媒体 I/O 的某个阶段。原写入结果始终保留为未知。

当前 native UUID/挂载/可写身份、容器指纹、唯一恢复 owner、固定 NFS 根及传输均有效，
没有 revoked 描述符；guest 未发现遗留探针进程或 `.platform-probe-*` 文件。
25 次同前缀只读 SSH 为 74–163ms；20 次真实完整 I/O 探针均成功清理，125–262ms。
没有发现本次需要再次替换硬盘身份、修改源媒体或复用昨日失盘因果的证据。
USB 断连的具体硬件诱因仍沿用[昨日记录](2026-10-29-identity-usb-and-negative-cache.md)中的未知边界。

## 修复、交接与回退

平台补丁 `af06d62` 为真实媒体探针记录 session、listing、write_fsync、hardlink、
rename_read、cleanup、complete 的 guest boot/CPU 与 host 收取时序。
失败写入独立、0600、fsync 的 `probe-failures.jsonl`，避免被周期日志覆盖；
不记录命令、generation、凭据或媒体标识。进度输出故障不妨碍 cleanup，留证失败不替换原异常。
完整 guest 回执后 SSH 仍超时的情况继续 blocked，不把进度当作写入成功授权。

Podsync 同时登记既有 `lease_stream = true`，使用已由平台验证的固定 SSH 发布会话，
每次新 host nonce 都取得新 Linux 时钟，完整匹配回执才生成原 ACK。
逐秒续租不再等待新建 SSH/guest Python 和进程退出；它不自动续租，不改变 probe 的七秒期限、
guest timeout 五秒、发布两秒预算、双时钟十秒 TTL、原门禁、三次观察规则或连接额度。
该配置移除了可复现的进程生命周期延迟依赖，不能倒推原未知探针的唯一底层原因。

09:27:38 在共享维护锁边界暂停本服务 owner 并正常发送 TERM；两个消费者均退出 0，
无 OOM。09:27:39 正常卸载闲置 NFS、恢复只读占位后，停止旧 owner 和传输。
保留全部容器 ID、镜像、Compose、源配置及 Cookie；只替换 Podsync 控制器并更新登记摘要。
09:27:40 注册新控制器，原恢复器完成介质、会话及 I/O 重验后启动原容器并 ready。
本次传输由原规则记账一次；没有人工清预算、新增许可、手造租约、第二 producer 或任务重放。

原 blocked 完整状态、原因、预算及历史快照均保留于受限证据目录。
新增 reviewed block/handoff 仅说明经过审查的全新准入，未把原未知结果改写为成功。
恢复器原有十分钟稳定后的自动额度恢复规则保持，原连接记录另在回执和窗口中保留。
实际控制器为 `runtime/control/media-recovery-podsync-probe-20261030/media_recovery.py`；
原 v2 gate 仍为 `runtime/control/media-recovery-podsync-v2-20261028-boot-budget/media-gate`。
回退必须同样正常排空、卸载、重新核对登记及制品后交接，保留新产生的账本；
不能仅改文件路径或直接启动旧 VM。

## 验证

隔离测试经过真实 probe/run_once，稳定重现两次观察超时后 SSH 未知、guest 完成后 SSH
收尾超时，以及写入后 fsync 未知。均拒绝签租、不重放、不新建传输；
写入中的未知临时文件在夹具中保留。另验证日志轮转、诊断磁盘写入失败、进度管道关闭和成功阶段。
平台显式 `check_local.py` 全部 27 条通过；默认 Python 3.15 缺少 PyYAML 的失败保留，
依项目现有 Python 3.14 环境重跑通过。Podsync 只有文档改动，未修改 Go 应用或重建镜像。

生产独立 transient cgroup 限 192MiB RAM、384MiB swap、90 秒，实际换出 137.48MiB。
320MiB 逐页内容完整校验、退出 0、OOM/oom_kill=0，单元已 collected；
期间三次实际生产采样、六次双消费者 gate 全部通过。
夹具没有执行抓取、下载或发布任务，也没有制造全局 OOM。

首轮真实读回确认登记和制品摘要、完整 nonce ACK、原 wall/boot TTL、generation、
两个 gate 与 Docker healthy 一致，应用二进制保持 `63525c0`。
源配置/Cookie 的宿主及容器内容、mtime、只读绑定不变；唯一 Badger writer 仍为 Podsync。
Tunnel/provider 未替换，既有 QUIC、TLS、Access 和媒体缓存规则保持。

09:29 的 D1 七次请求均为 SELECT、rows_written=0。
26 个 run、3176 条事件逐轮序号连续、去重及累计计数匹配。
两条旧 feed timeout 后均已成功；配置 timeout 后已有 48 次 fetched。
交接前 run 正常闭合 success、28 feed/1 download/1 upload/0 error；新 run 正常推进。
stdout 一次事件上报 warning 不重复计为 D1 媒体上传失败，也不据此声称其底层传输原因已唯一定位。

两条原失败 feed 的最新节目加当前最新节目共三组，真实文件均存在、硬链接数 2、大小匹配 D1。
容器 nginx 与 Mac/NAS 原地址均为 Range 206/1024、Content-Range 总长正确，前缀匹配源。
双侧 RSS 200、enclosure 各唯一、length 正确；Worker 200/ok、media healthz 204、
dashboard 302 至既有 Access。

## 固定一小时窗口及最终读回

09:28:39–10:28:39 固定窗口未重置。241 次十五秒采样、482 次双消费者实际 gate 全部通过，
每次完整 ACK、原十秒 wall/boot 期限、generation 和健康均有效；消费者 StartedAt 未变。
观察事故维持原 51 条，新增 probe/publication failure 为零。
保留并去重的 2630 次 Docker 观察、2630 次 native 观察、322 次完整 I/O 探针均成功；
I/O 最大 477.21ms，全部有 cleanup/complete。
2629 次窗口内续租仅一个发布进程，中位 4.70ms、最大 100.01ms；首次启动计入更早的交接阶段，
没有把窗口数冒称所有生命周期操作。Docker/native 最大分别为 326.45/66.70ms。

61 次内存样本最低可用 2322.29MiB，最高 swap 使用 2704.72MiB。
最终内核读回自 swap 启用后仍无 global OOM/内核 OOM kill。
窗口覆盖了正常一整轮同步及真实限额换页，未执行全局 OOM、拔盘或 VM 重启注入；
不能保证任意未来负载、USB 故障或所有管理调度停顿均不会复发。

10:29 的初次最终容器逐字段断言失败。保存完整当前 inspect 后核实只有 `Mounts` 列表顺序变化，
ID、镜像、Config、HostConfig 和排序后的每个挂载完全相同，原登记指纹继续有效。
按已有指纹的 Destination 排序规则修正验收比较后通过；原失败日志保留，未改生产挂载。

同次最终 D1 请求收到 403/7403，提示账号无效或未获服务授权。
原错误保留；正常 whoami 确认同一账号仍在列表、OAuth/D1 scope 有效。
没有改账号、凭据、Access 或配置，随后一次正常重验的七次 SELECT 全部成功、rows_written=0。
这足以确认当前读取恢复，不能把该次 403 的唯一底层原因解释成凭据过期或某个网络故障。

10:31 的最终 D1 为 27 run、3322 条事件，序号连续、去重及四项累计计数吻合。
09:27:43–10:27:55 的恢复后完整轮自然闭合 success、28 feed/0 download/0 upload/0 error；
下一轮 10:27:56 开始，已 28 feed、错误 0、事件新鲜，不把正常 running 判为卡死。
两条旧失败 feed 继续成功，配置失败后 fetched 已达 60 次；历史三个 D1 error 保留。
这轮没有新下载，因此未为制造下载/上传样本触发业务。

当前容器日志自昨日 08:14:39 起，覆盖本次真实滚动 24h 截止，不存在昨日重建缺口的误套。
80317 行中 error 3（feed timeout 2、配置刷新 1）、warning 49（不可用跳过 48、事件上报 1），
fatal/panic 为零。日志和 D1 同次失败不重复加总；本轮没有清错误或队列。

最终三组原地址的容器及 Mac/NAS RSS/enclosure、真实文件/D1 大小、硬链接、
Range 206/1024/总长及源前缀 SHA-256 再次通过；Worker、media healthz、Access 均通过。
Cookie/config 内容与 mtime、只读绑定、原 gate、应用二进制和 Compose 再读一致。
原 NAS 未发现 Podsync/dockerd/containerd，当前仍唯一 Badger writer；未启动旧 VM/NAS 服务。

原始证据位于
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-probe-timeout-20261030/`。
