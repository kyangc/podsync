# 2026-11-04：guest 租约发布 I/O 停顿、审查恢复与取证补全

时间均为 Asia/Taipei（UTC+8）。本轮修复实际双门禁失败，并对账两项新的远端最终警告。
**已恢复准入、修复取证缺口；底层间歇存储停顿尚未根治。**
不能用重新准入成功替代根因证明，亦不把本次失败并入
[11 月 1 日已审查的未知发布](2026-11-01-unknown-lease-publication.md)。

## 本次阻塞实际发生在哪里

08:03 原恢复器 blocked，原因是今日 01:42:32 的
`registered lease publisher` 三秒超时。两个原消费者 running/unhealthy、RestartCount 0，
实际原 Entrypoint 门禁执行 `/bin/true` 均为 75；producer 内租约文件不存在。
内部 `/health` 与 Mac/NAS 公开交付仍正常、feed 仍更新，不能据此称控制面健康。
原 ready_since 为 11/2 17:12:03，不代表当时处于 ready。

新诊断保留了失败请求的 guest 阶段，已将阻塞缩小到发布文件路径：

| 原观察 | 连续时间或耗时 |
| --- | --- |
| guest 初始时钟 | 01:42:28.867326 |
| request_received → clock_sent | 1.157ms |
| clock_sent → lease_received | 0.722ms |
| write_begin → file_fsynced | 2,422.388ms，guest CPU 约 9.810ms |
| rename_begin → renamed | 143.589ms，guest CPU 约 0.333ms |
| 超时最后 guest 标记 | renamed；没有 readback_verified 或 ack_sent |
| 宿主发布调用总耗时 | 约 3.110 秒，包含退出清理 |
| 宿主最大 poll gap / suspend 差 | 101.405ms / 17.542µs |

01:42:31.976 与 01:42:32.476 两条 TimeoutExpired 是同一调用的内外层留证，
01:42:33.013 为 cycle 结果，不是三次独立请求。宿主没有收到完整 published 回执，
原写入结局仍为 unknown。原 56 条 inspection 历史和本次未知发布分别保留。

租约文件实际位于内置盘 runtime 的 **VirtioFS** 共享目录，不在 4T 的 NFS 媒体根。
同窗 guest 采样 MemAvailable=3,162,216kB（约 3.02GiB），CPU/memory/I/O PSI some avg10
分别为 17.96%/17.89%/17.75%；采样发生在上述长写入区间内。
这些是压力线索，不能据此断言 OOM、某容器内存上限或 USB 故障。

本轮还取得宿主 01:42:20–01:42:40 的原始统一日志：
01:42:31.141 的 APFS disk3 事务记录准备 flush 前等待 1,544,533µs，
01:42:32.470 另一个事务记录关闭耗时 1,042,350µs。
当前同一运行环境的 Data 卷为 disk3s5/APFS container disk3、内置 SSD；4T 为 disk7。
这把调查方向进一步缩小到内置盘存储路径的同窗延迟，但没有请求与 APFS 事务的关联 ID，
不能把两个时间直接相加解释该请求。同期 memorystatus 明确为 idle-exit 的守护进程回收，
不能称为 VM 被 OOM 杀死；guest kernel journal 在原两分钟窗口无条目。
平台观察器同时记录磁盘可用空间低于原 30GB reserve，也不能单独证明停顿由容量引起。

隔离临时目录中，VirtioFS 和 guest ext4 各 32 次相同小文件操作未复现秒级停顿；
没有给生产施压、重放原请求、调整 VM/网络或删除文件来制造恢复。
原 write_begin 标记包含创建、fchmod、序列化、flush、fsync，故 **2.422 秒不能全算作 fsync**。
目前仍无法在原样本中唯一确定具体阻塞 syscall 或底层触发者。

## 实际修改与受控恢复

平台源码 `79bbbe24666b54f7e5d94663369c305dd0a199a5` 仅修复两项已复现的取证缺口：

- 在原 16 条阶段容量内，将十个粗阶段细分为十六个，区分创建、fchmod、序列化、flush、
  fsync、关闭、rename、readback 与 ACK。阶段写入仍为尽力、非阻塞的诊断。
- 有界内存保留最近八次已过滤的成功发布；调用失败时将它们写入原 failure 分段，避免
  每小时成功采样丢失紧邻上下文。上下文有明确标志，不记为失败或未知写；队列仅剩一格时
  优先保留实际失败。重复外层错误不再次展开上下文。

仍使用原字段/深度、16 阶段、8KiB 单条、64 条队列、分段与七天年龄上限。
不保存 nonce、命令、lease payload 或任意字符串，不将诊断用于准入。
完整 nonce ACK、boot ID/generation、双时钟十秒 TTL、两秒发布预算、三秒交换/观察期限、
未知写入阻塞规则均未改变，没有自动重新执行未知发布。

08:09:41 前保全原状态、配置、激活、诊断、身份与输入哈希，确认旧 publisher 不存在且无
活动下载/转换。在共享维护锁下通过原持久 TERM 账本正常排空两个原会话，均退出 0。
截至 drain 的近 24 小时旧 ID stdout/stderr 已私有归档、读回核对时间、大小、SHA-256、
完整行及正常退出尾部；目录 0700、日志 0600。producer 的最后记录为 08:09:41.932。
最终查询从昨日 08:09:42 开始，窗内首条可用记录为 08:13:52；较早原始捕获保留窗前
08:08:52 记录，随后同样接至 08:13:52，未填造该正常日志间隔。

停机后以只读挂载审查 Badger：全部值可读取，tombstone cursor=3177、更新时间
08:08:52，待发事件 0、pending 发布任务 0。没有改库、截断、清账或重放未知任务。
正常卸载原 NFS、恢复只读占位并关闭旧传输后，重新登记 Podsync 专用制品：
`runtime/control/media-recovery-podsync-context-79bbbe2-20261104/`。
观察 helper 仍为原 f591dea 字节，全局 wrapper、v2 gate、应用镜像、两个容器 ID、配置与
源 Cookie 保持。所有原历史、未知结果和预算保留，追加 reviewed block/handoff。

08:09:47 由原恢复器完成新传输、介质身份、硬链接及 I/O 证明并恢复 ready；
使用一次原自动连接额度，没有手设 ready、手造租约或扩大预算。

## 两项远端警告逐项闭合

11/3 11:28:49 的最终 `remote event upload failed` 对应两次 remote_events EOF：
156ms、152ms，均最后观察到 TLS，未观察到请求写出/响应头；第一次有两次连接获取且
trace_ambiguous=true。不能据此证明服务端没有收到原 POST。
11:27:49 的同轮事件 sequence 5–6 后续已在 D1 读回，原 11:22:50–12:23:49 轮
最终 success，121 条唯一连续序号 1–121；28 feed/1 download/1 upload/errors 0
与事件计数一致。正常停机 outbox 为空，最终批次已闭合，原失败请求的接收结果仍未知。

11/4 03:17:49 的最终 `remote tombstone sync failed` 对应两次 GET EOF：164ms、216ms，
均最后观察到 TLS、未观察到请求写出/响应头、trace_ambiguous=false。
原 `tombstone_apply_failed` sequence 96/error_code=tombstone_sync_failed 保留。
03:18:52 自然出现 sequence 98 fetched(changes=0)、99 applied(next_cursor=3177)，
随后持续成功。D1 tombstone_changes 高水位/行数均为 3177，与本地持久 cursor 一致；
恢复后 08:09:50 又自然完成同 cursor 的空批消费。没有拿媒体 visible 或 metadata 覆盖写
代替删除应用账本核对，也没有手动发起同步或删除。

另将 D1 截至 sequence 3177 的全部最新变更逐身份对照本地持久标记：1,616 项的
feed/episode、sequence、status、action、created_at 全部一致。最后三项 purge
3175–3177 在 02:17:50 已应用，早于本次 03:17 的空批 GET 失败；没有把该次读取失败
说成三次删除失败，也不从标记推断所有物理清理动作的结局。

两项 EOF 与 01:42 的控制文件发布超时不重合，不能归为同一个底层原因。
本轮其他 remote_events 内部 EOF 与最终警告分别计数；它们不等于新增独立终态失败。

## 已完成验收与保留边界

平台 32 组显式本地检查通过；实际 Podsync arm64 Linux 镜像中 103 项针对性检查通过。
缺 ps 的两个进程树用例在宿主通过，其余在隔离容器内执行；未启动第二业务 writer。
实际生成 publisher 的创建/fchmod/flush/fsync/rename/readback 与扣留 ACK 夹具均覆盖，
未知结果仍 blocked、无 host ACK、无重放、attempts 不变。未修改 Go 应用或镜像，
不以这些检查代替真实生产门禁、租约和媒体核验。

08:10:47 读回双 healthy、双实际 gate 0、单 writer/owner、新有效传输根，应用仍为
`9efb508`，二进制/manifest/yt-dlp/ffmpeg 哈希与原登记一致；输入哈希、mtime、只读绑定保持。
新生产持久诊断已含细分 syscall 标记，dropped/write_failures 快照为 0。
成功回执可先于末尾 stderr 标记被宿主读取，成功样本不保证收齐十六条；准入仍按完整协议 ACK
验证，超时路径的最后有界 drain 已由夹具验证，不将缺少成功尾部标记误判为发布失败。

父巡检两份原样本为 11,415,276 / 15,897,317 字节，另验最新 26,531,444 字节和
历史失败后恢复的 59,424,894 字节样本。四份的 Mac/NAS 两侧 RSS 200、enclosure 唯一、
length/D1/源大小一致；八次 Range 全部
206/1024 字节、Content-Range 总长正确，前缀 SHA 与真实源一致。实际硬链接数均为 2；
每份均恰有一个原下载文件与其同设备同 inode，容器源站也通过相同核验。
两侧 Worker 200/ok、media healthz 204、Dashboard 原 Access 302，
TLS 验证通过，没有关闭 TLS/Access 或改变探针失败后的服务保护。

必要的正常重启在 08:09:49 自动执行原启动更新检查，再次遇到 GitHub release API
403 rate limit（同一次操作两条 error），下载器仍为 2026.10.26、哈希未变。
11/3 自然更新失败和本次启动检查均未恢复；没有手工重复更新或更改更新频率。
原按进程启动/更新完成后等待 24 小时的规则继续，因此旧进程的 08:57 预期点不再适用。
近 24 小时原实例 81,706 行日志中 warning 50（既有 Bilibili 跳过 48、上述最终警告各 1），
error 2 为同一次旧更新检查；fatal/panic 和真正 feed/download 终态失败均未见。

按原 drain 截止点取完整 24 小时 event_time 窗口（11/3 08:09:42–11/4 08:09:42），
22 个已观察节目均恰有一次发现、下载、上传与上报，无相关失败或重复事件。
07:59:57 的下载已在原进程正常闭合为一次上传/上报，原轮于 08:09:41 success，
不是以尚在进行的批次判卡死。此核对不证明 discovery 从未观察到的源端项目没有遗漏。

08:10:11–08:30:12 完成 1,201 秒连续观察：41 组完整 ACK/boot/generation/双时钟十秒 TTL
证明、82 次实际门禁均通过；ready_since 始终为 08:09:47，未发生新状态转换、控制失败、
inspection 事故或消费者重建。原 600 秒稳定规则自然释放自动额度，原一次连接仍保留于
观察证据，没有人工清预算。08:30:28 最终读回仍为双 healthy/双 gate 0、RestartCount 0、
单 writer/owner，原 56 条历史、未知结果、输入和制品哈希保持，新诊断 dropped/write_failures 为 0。

08:28:52 的按 started_at 滚动 24 小时 D1 窗口为 24 轮：22 success/1 partial/1 running，
累计 672 feed/22 download/22 upload/errors 1；唯一错误为原 tombstone GET 失败。
所有轮次序号唯一连续，累计计数与事件数一致。此口径与上述固定 drain 窗口的 event_time
不同，不混用两者总量。新进程已自然完成 28 个 feed、errors 0，没有新下载/上传，
配置获取 4 次、tombstone 空批应用 7 次，最新 D1 事件为 08:25:24；当前轮 running 符合原调度，
没有为验收制造新下载。原 07:42:50 轮已在正常 drain 时 success 闭合，28/1/1/errors 0。
所有只读 SELECT 的 rows_written 均为 0。

截至 08:30:27 的新会话 3,416 行日志为 info 3,412、既有 Bilibili 跳过 warning 2、
上述启动自更新 error 2；没有新远端最终警告或 feed/download 终态失败。
恢复后的自然完整 feed 发布最近为 08:10:55，配置/tombstone 刷新继续至 08:30:24；
没有以配置刷新时间替代完整 feed 成功时间。

平台代码提交 `79bbbe2` 已推送；生产登记仅更新 Podsync 子树，保留平台其他未提交修改。
最终回执包括 `verification-final.json`、`monitor-result.json`、`d1-final-summary.json`、
`delivery-aggregate.json`、`tombstone-ledger-summary.json` 与原 ID 日志归档回执。
原始受限证据位于
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-lease-recovery-20261104/`。
本轮没有证明未来不会复发；APFS/VirtioFS 的间歇等待、具体触发工作及 GitHub 限流仍为剩余边界。
本次 NAS 样本无失败，历史 NAS 间歇 TLS 的原因仍沿用此前未定结论。
