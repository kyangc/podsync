# 2026-11-13：磁盘压力停机后的 PersonalCloud 重新准入

时间均为 Asia/Taipei（UTC+8）。11/13 08:17 已由原恢复器完成全新准入，08:38 通过
完整生产验收：两个原消费者、20 分钟稳定观察、自然同步、持久账本和双侧媒体交付均通过。
原租约调用的 guest 具体异常和写入结局仍保留为未知，不据恢复成功宣称它已根治。

## 故障与原因边界

11/12 18:34:20，同一 `ssh.lease_v2_stream` 调用在
`request_received → clock_sent → lease_received → write_begin` 后断开。
未观察到 `temp_opened`、完整 guest 回执或 host ACK；内外层两条 `unknown_write`
是同一次调用，不能算成两个独立故障。原写入结局和具体 guest syscall 仍未知。
同期 Monga 宿主状态写入明确返回 ENOSPC，现场宿主仅余约 184MiB，是共同磁盘压力的
强证据；Podsync 没有 guest 异常栈，不能据此断言它已捕获某个 ENOSPC syscall。

原恢复器撤租并正常排空，producer 与 media 于 18:34:22 退出 0，非 OOM、无重启。
之后平台冷迁至 PersonalCloud，guest 冷启动，旧 publisher 无法跨关机存活，但这不改变
原调用的未知结局。原 blocked、预算、消费者身份及账本均被保留，业务未自动恢复。
11/13 本轮基线仍为两个消费者停止、guest 只读 mode=000 的离线 tmpfs、无有效媒体租约。
RSS、Worker 和 Access 可访问，实际媒体 healthz 与抽查 Range 均为 502。

另独立复现了迁后的恢复阻碍：`runtime` 已成为兼容软链接，而冻结 transport 的 sandbox
仍按逻辑路径授权。macOS sandbox 按物理路径匹配，因而拒绝既有控制目录中的库、exports
与日志路径。隔离回归在原 Podsync transport 上出现三项拒绝，精确解析这三个原白名单
位置后通过；无关目录与控制库写入仍拒绝。该问题影响迁后重新连接，不能倒推为迁前
18:34 未知写入的触发原因。

## 保全、审查与最小修复

- 在任何恢复变更前保存原 config/state/activation、诊断、输入哈希与 mtime、两个原
  容器身份及退出状态。归档截至正常 drain 的完整 24 小时旧 ID stdout/stderr，逐行验证
  时间戳、完整尾行、大小、SHA-256，并读回 producer 正常退出尾部及两容器退出状态。
  media 最后一条访问日志早于退出，不把它当作退出日志。producer 查询范围为
  11/11 18:34:23 至 11/12 18:34:23，首条可用日志 18:36:55、末条 11/12 18:34:22；
  正常日志间隔与停机后空窗没有补造。没有重建或移除消费者。
- 保存 433,854,976 字节停机库 tar，并完整读回全部文件。原库通过只读挂载、
  `WithReadOnly(true)` / `WithTruncate(false)` 审查：全部值可读，cursor=3451、
  outbox/pending=0，8 项 failed 为原历史。远端高水位 3455，恰有四项停机后 delete；
  原配置 10,110 字节、28 feeds，匹配最后接受缓存，没有手写 cursor 或重放旧任务。
- 仅为 Podsync 创建新的冻结制品目录
  `runtime/control/media-recovery-podsync-personalcloud-20261113/`。
  transport 与已推送平台源码 `78b8d97` 完全一致，只把原控制目录、exports 和日志白名单
  解析为精确物理路径。应用 `9efb508`、控制器 `79bbbe2`、观察 helper、全局 wrapper、
  v2 gate、消费者原 ID/镜像/配置指纹与源 Cookie 保持。
- 原 owner 的正常 bootout 返回后，首次立即查询仍看到短暂存活，因此按守卫暂停；
  随后只读确认原 PID 消失、launchd 项已卸载、状态完全未变及 owner 锁可获取，再继续
  交接，没有重复 TERM、重放请求或重叠 owner。
- 在原共享维护锁与 Podsync owner 锁下追加 reviewed block/handoff，保留全部原历史、
  未知样本和预算，更新 config/activation 摘要与原守卫启动入口。原自动额度尚可用，
  本轮使用一次原自动连接额度，没有新增人工许可、清预算或制造租约。
- 原恢复器重新建立 NFS，验证原 4T UUID、介质读写、硬链接、session、boot/generation
  与完整 nonce ACK 后启动两个原消费者。双时钟十秒 TTL、两秒发布预算、原 SSH 与观察
  期限保持。没有直接 compose up、启动旧 VM/NAS writer 或新增媒体 VirtioFS 直挂。

## 已取得的生产读回

08:17 的初次验收为双 healthy、双实际 gate=0、RestartCount=0、单 writer/owner，
应用二进制和 source-manifest 匹配原发布登记，内部健康基于本轮完整 feed 发布成功。
源配置/Cookie 的哈希、mtime 和只读绑定保持。新 NFS 根有效，完整 ACK、guest boot、
generation 及双时钟十秒 TTL 实际匹配；原未知结果仍在 reviewed history。

恢复后四项 tombstone 已自然应用。对文件集合/大小/mtime/inode 在复制前后均不变的
在线数据库快照，仅在隔离 Linux volume 执行 Badger 原生恢复、`WithTruncate(false)`，
没有打开或改写原运行库。读回 cursor=3455，四项身份/序号/状态/动作/created_at 均与
远端相同，8 项历史 failed 的完整值与停机前逐值一致。08:28 的第二份稳定文件副本
读回 pending=0、待发事件=0、succeeded 从 2,279 增至 2,294。保留的一个 active run
是当前正常小时窗口；其计数匹配 D1，next_sequence=128、D1 已连续接受至 127，
不是遗留未上报事件。原退出时 partial run 的全部持久远端结果也逐值保持。

首轮四份历史媒体覆盖本次父巡检的两份失败交付样本。D1、真实源大小和 RSS length
一致，enclosure 各唯一，原下载与发布文件各有一个同设备/同 inode 的硬链接。
Mac/NAS 共八次 Range 全为 206、1,024 字节、Content-Range 总长及源前缀 SHA 一致，
均为缓存 MISS；容器源站同样通过。两侧媒体 healthz=204、Worker=200/ok、
Dashboard=原 Access 302，TLS 校验通过。

原 11/12 13:13 的 YouTube 403 样本与恢复后的一个新重试样本，分别关联到唯一一次
发现/下载/发布/上报，没有终态失败；18,816,320 / 1,503,402 字节两份媒体又通过四次
双侧 Range 与源前缀核验。原 11/12 18:12 的 Bilibili discovery 超时 feed，已在
11/13 08:24:40 自然完整更新成功，未手工触发。08:28 的远端读回为新进程第一轮
28 个 feed、15 个新节目；15 个身份各有唯一一次发现/下载/发布/上报，终态错误与重复
发布组均为 0，序号和累计计数逐轮匹配。两条新应用诊断失败仅为既有 Bilibili -404
样本跳过，dropped/write_failures 均为 0；原失败历史没有删除。

又抽查四份本轮自然发布媒体，Mac/NAS 八次 Range 与源前缀一致。其中 14,345,665 字节
的一份精确对应本轮第二次 YouTube HTTP 403 重试，其下载/发布/上报也各一次成功，
又补核双侧 Range。因此四组共十个不同节目、二十二次 RSS/Range 检查均通过；前三组
首次请求均为 MISS，容器源站也通过。其中三份历史媒体的源前缀和大小还与迁后、
准入前保存的样本完全相同。

新会话日志的四条 error 合并为两次 YouTube 瞬时下载操作：08:17:39 的 challenge/EOF
和 08:23:58 的 HTTP 403，均沿用既有重试后成功；四条 warning 为这两次重试及两条
既有 Bilibili 不可用样本跳过。fatal/panic、远端最终警告与 D1 新终态错误均为 0，
没有把日志行数混作独立业务失败数。

平台存储与控制回归 130 项通过；显式完整本地检查共 34 组命令通过，使用既有隔离
PyYAML 依赖，没有修改宿主软件包。没有修改 Go 应用或镜像，因此不运行无关 Go 测试。
维护参考当前入口与每日巡检保存文本已修正为 PersonalCloud；巡检时间、目标 chat、
只读范围、修复授权和报告规则经更新后读回确认保持。

## 稳定观察与最终边界

08:17:54–08:37:55 完成 1,201 秒连续观察：41 次完整 ACK/boot/generation/双时钟 TTL
证明、82 次实际门禁全部通过；原 ready_since、两个消费者会话、RestartCount 和
inspection 历史均保持，没有新控制失败或非 ready 周期。活动自动连接窗口已由原
控制器在 600 秒 ready 后自然释放，原一次连接仍保存在准入与连续观察证据中，
没有人工清预算。应用、downloader 与 ffmpeg 实际哈希也匹配原登记。

08:38 最终读回仍为单 writer/owner、双 healthy/双 gate=0、完整有效 ACK、内部 healthy，
最新完整 feed 成功为 08:24:45；远端当前正常小时窗口为 28 feed、15 下载/发布/上报、
errors=0，最新已读事件为 08:35:20。两侧公开 Worker、媒体 healthz、原 Access 与 TLS
再次通过。最终隔离副本复核 pending=0、待发事件=0、cursor=3455 和原 8 项历史失败保持。

实际共享 transport 修复源码为平台 `78b8d97`；生产登记只更新 Podsync 恢复字段。
本项目仅提交本记录和维护参考，原他人未提交的 `DEPLOYMENT.md` 迁盘修改完整保留。
每日巡检保存文本仅修正存储说明，原时间、目标 chat 与授权规则均未变。

受限原始证据、数据库副本、业务身份与 URL 仅保存在
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-recovery-20261113/`，
目录 0700、证据文件 0600；不会写入 Git。源 Cookie、原历史媒体与失败任务未清理。
本次恢复不证明所有历史媒体、所有网络地区或供应商未来内容均正常，原 guest 具体异常
及历史 NAS 间歇 TLS 的底层原因仍保留为未知。
