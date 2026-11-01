# 2026-11-01：未知租约发布超时的审查恢复与留证修复

时间均为 Asia/Taipei（UTC+8）。本轮处理日巡确认的双媒体门禁失败，
与[昨日维护卸载](2026-10-31-planned-usb-reconnect.md)及已恢复的下载错误分别核验。

## 已证实故障与原因边界

08:13–08:15，`podsync` 和 `podsync-media-1` 原 ID 均 running/unhealthy、RestartCount 0；
按实际 Entrypoint+Cmd 截至 `--` 的原门禁前缀执行 `/bin/true`，两者均返回 75。
应用内部健康与公网媒体当时仍可用，不能据此替代媒体准入。

恢复器保留 `blocked`，原因是 10/31 23:13 的固定租约发布请求超时。
guest 初始时钟为 23:13:09.758，宿主收到时钟并送出授权后停在 `await_publication`；
23:13:13.055 留下 TimeoutExpired，连续时钟耗时约 3.262 秒，原请求期限约三秒。
宿主 suspend 差约 25 微秒、wall 与 continuous 差约 6 微秒，不能解释该超时。
第二条同请求失败记录是外层留证，不是第二次自动重放。
23:13:15.159 状态落为 blocked，租约与 ACK 撤销。

原 56 条 inspection 历史中的最后一条始于 23:12:45，23:13:01 已 resolved；
随后未知租约写入不能并入这条已恢复观察，也不属于 23:05 旧结案。
同窗 Monga 也有固定 ID 观察期限失败，但这只说明时间相关，不能作为共同底层根因。
当时 host load 约 13、可用磁盘约 5.17 GB 是诊断 worker 的事后采样，不能单独归因。
本轮 guest kernel journal 对该三分钟窗口无条目，不能据此排除所有资源或 I/O 故障。

已部署 guest 早已输出分阶段诊断，但 Podsync 的 `EvidenceJournal` allowlist 丢掉了
`guest_progress`、`guest_resource`、`max_poll_gap_ns` 及清理标志。
因此当前原样本仍无法区分授权送达、guest fsync/rename/readback、ACK 返回或宿主调度；
原请求结局保持 unknown，缺失阶段不可补造。没有将其套作旧 OOM、USB 或 TLS 原因。

## 实际修复和交接

共享平台源码 `7ce14e32ba6434a63abab390021b07e574e0d461` 修复有界持久留证过滤器，
保留原有十个固定阶段、数值资源/采样时间、poll gap、诊断异常计数与本地清理标志。
原 16 条阶段、字段/深度、8 KiB 单条、队列/分段/年龄上限继续有效；
不保存 nonce、lease 内容、命令或任意资源字段，不让诊断成为准入依据。
没有放宽完整 nonce ACK、boot ID/generation、双时钟十秒 TTL、两秒发布或三秒交换预算。

08:18:31 前保全原 config/activation/state、原诊断与传输记录，并确认原 guest publisher
已不在、没有活动下载/转换、源配置/Cookie 哈希及 mtime 不变。
在共享维护锁下暂停旧 owner，由原持久 TERM 账本正常排空两个原会话；两者退出 0，
未强杀或重复未知信号。原 ID 截至 drain 的近 24 小时查询 stdout/stderr 已归档、
读回并核对时间、退出尾部、大小与 SHA-256，目录 0700、文件 0600。
producer 仅从昨日 15:19:20 有可用日志；已知昨日 08:03:43–15:11:27 旧 stdout 缺口保留，
没有冒称完整 24 小时。media 原 ID 的多次会话日志一并保留。

08:18:33 正常卸载旧 NFS、恢复只读占位，再关闭旧 owner/传输并确认原 PID 消失。
保留全部历史、原两次自动 attempts、人工许可及未知结果，追加 reviewed block 与交接记录，
重新登记 Podsync 专用冻结制品：
`runtime/control/media-recovery-podsync-evidence-7ce14e3-20261101/`。
控制器及 `lease_diagnostics.py` 取自上述提交，观察 helper 保留原 `f591dea` 字节；
全局 wrapper、实际 v2 gate、两个容器 ID/镜像/配置指纹不变。
未修改 Monga 制品、业务频率、源 Cookie、队列或原账本，也未创建第二 writer。

08:18:37 经原恢复器完整新传输、介质证明与 I/O 探针恢复 ready，两个原 ID 启动并 healthy。
自动 attempts 仅从 2 增至 3，使用剩余原额度；没有清预算、手造租约或手设 ready。
原失败保持在初始证据和 reviewed block 中；重新准入成功不改写原未知写入结局。

## 回归、生产与业务核验

修复前，实际生成 publisher 的 fsync 卡住和“guest ACK 已完成、返回通道扣留”两种夹具
均复现有界持久记录缺少阶段。修复后分别保存 `write_begin` 和 `ack_sent`，
两次 controller cycle 后仍 blocked、无 host ACK、无重放、attempts 不变。
平台 30 组显式本地检查通过；实际 Podsync Linux 镜像内 101 项检查通过。
Linux 镜像缺 `ps` 的两个进程树检查在宿主通过，其余针对性用例在容器通过。
本轮未修改 Go 应用或镜像，未重复运行整套 Go 测试。

08:21:56 生产读回确认：实际二进制/source manifest 仍为应用 `9efb508`；
双 healthy、双原门禁返回 0、RestartCount 0、单 Badger writer/单 owner、新传输根有效。
完整 ACK、boot ID/generation 与原十秒 wall/BOOTTIME TTL 通过；
源配置/Cookie 哈希、mtime 和只读挂载保持。完整 feed 发布自然推进至 08:19:47。
新有界持久记录实际含 guest 阶段、资源时间与 poll gap，已落盘记录的 dropped/write_failures
快照为 0；不是用夹具或内存状态代替生产留证。

两个最新媒体与一个原失败后恢复节目分别为 24,292,163、12,408,324、59,424,894 字节，
宿主实际硬链接数均为 2。容器源站以及 Mac/NAS 原订阅地址均验证：RSS 200、
enclosure 唯一、length/D1/源大小一致；媒体 Range 206/1024 字节、总长及前缀 SHA 与源一致。
两侧 Worker 200/ok、media healthz 204、未认证 dashboard 302 到原 Access、TLS 验证 0。
父巡检首次两个 NAS 8 秒探针 curl 28 保留；原 30 秒条件的普通复验及本轮相同条件均通过，
不能从重试通过倒推或宣称 TLS/传输瞬态原因已修。

08:19:53 的 D1 近 24 小时共 30 轮：25 success、4 partial、1 running，
各轮 sequence 唯一连续且计数一致；原运行轮在 08:18:31 正常闭合为 success。
新进程当时已自然完成 25 个 feed、errors 0，无重复发布组；SELECT 的 rows_written 均为 0。
本轮没有手动同步、重放节目或制造新故障来验收。

昨晚 23:05 以后新增的三次下载失败均来自同一 YouTube 节目，终态为
`Requested format is not available`，每次 attempts 1、extract 阶段、约 4.2–6.7 秒；
不是超时或无数据块。05:04:57 自然下载成功，05:06:31 发布、05:06:32 上报成功，
其 59,424,894 字节媒体已纳入上述两侧交付核验。格式列表为何先不可用后恢复仍未知，
未修改格式选择、下载器或重试预算。

旧 ID 全部可用 stdout 的 35 条 error 分类为昨日维护期 feed update 28、stat 1，
及上述三次下载各两条调用/详细错误；warning 47 为既有 Bilibili 不可用跳过 44，
及这三次失败摘要 3，fatal/panic 0。
不能把日志条数当独立任务错误数，也不能用 D1 完整性填补旧 stdout 缺口。

08:24:30.867–08:24:40.968 有一次约 10.10 秒共享维护锁等待，恢复器按原规则撤租、
解锁后重新验证恢复 ready；消费者 ID/StartedAt、事故历史及 attempts 均未变化。
30 秒实际门禁采样未碰到该短窗口，但持久 cycle/wait 记录保留了它，不能声称始终有租约。
原共享锁持有者的具体工作尚未归因；不将正常 waiting 记作未知发布重试或新故障。
最终观察延长至最后恢复后的 20 分钟。

08:44:55 最终读回仍为双 healthy、双实际 gate 0、RestartCount 0、单 writer/owner、
完整 ACK/boot ID/generation/原十秒双时钟 TTL，有效传输根与原源输入哈希均匹配。
共完成 53 组完整租约证明和 106 次实际 gate 采样。最后一次完整重新验证后的连续 ready
为约 1,213 秒，期间未再出现状态转换、
观察/发布失败或新 inspection 事故。原 56 条事故及全部未知结果保留。
08:34:41 原 600 秒稳定规则自然释放自动额度，原 attempts 仍在审查交接记录中，
人工预算不变；没有人工清理。

08:42:26 最终 D1 仍为 30 轮、25 success/4 partial/1 running，sequence 与计数一致，
新进程 28 feed、errors 0、无重复发布组；最新自然事件为 08:38:59，所有 SELECT 写入数 0。
新进程截至 08:42:27 的 3,359 行日志为既有跳过 warning 2、error/fatal/panic 0、
远端事件上传失败 0；这不是全日 stdout 总量。

最后媒体验收中，Mac 三样本及容器源站再次全部通过。NAS 第一条 RSS 曾出现 curl 35，
TCP 约 2.45ms 已完成、TLS 未完成，约 3.08 秒失败；其余两条 RSS/Range 和健康/Access 通过。
该原失败保留在 `delivery-NAS-final.jsonl`。对同一失败地址仅做一次原 30 秒条件复验，
RSS 200/enclosure 唯一、Range 206/1024/总长/源前缀及 TLS 验证 0 均通过，
另存 `delivery-NAS-final-retry.jsonl`。原失败没有原始 curl stderr，细分原因仍未知；
复验成功没有覆盖原失败，也不能将默认的 TLS verify 数值当作已证实证书问题。
当前交付可验收，NAS 间歇 TLS 失败仍未治愈。

生产登记仅更新平台 `current-release.json` 的 Podsync 子树，保留其他服务登记。
实际控制器源码与冻结制品为 `7ce14e3`，最终配置/manifest 哈希与实际读回对齐。
最终回执为 `verification-final.json`、`monitor-result.json`、`d1-final-summary.json`，
包括中途共享锁等待、自然预算释放和失败复验边界。
受限证据目录：`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-lease-recovery-20261101/`。
本轮验收的是准入恢复与取证缺口修复；底层间歇停顿、旧 HTTP/TLS 和硬件长期稳定性仍未证明。
