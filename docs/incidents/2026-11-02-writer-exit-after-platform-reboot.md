# 2026-11-02：平台重启后异常 writer 结局的审查恢复

时间为 Asia/Taipei（UTC+8）。本轮处理日巡确认的媒体交付中断，沿用
[11 月 1 日控制器与未知发布记录](2026-11-01-unknown-lease-publication.md)。

## 故障与证据边界

08:00 前后，两个原媒体消费者均 exited，ExitCode 255、OOMKilled false、
RestartCount 0，Docker State.Error 为空。唯一 producer 已停止，内部健康与实际门禁
无法执行；恢复器 blocked，原因为 `writer outcome requires review: podsync`。
Worker `/health` 200/ok 和缓存 RSS 200 不能代表音频可交付：Mac/NAS 两个原样本
共四次媒体 Range 均为 502、16 字节错误体，媒体 `/healthz` 也是 502。
未认证 Dashboard 仍为原 Cloudflare Access 302。

昨日 10:50 的两个 TERM 请求有持久账本，均正常退出 0，10:58 重新启动。
它们与本次异常退出不是同一个结局。原 producer 日志最后完整 feed 发布为昨日
17:00:40，之后只有配置/事件刷新，最后 stdout/stderr 为 17:29:30。
有界诊断在 17:30:06–17:30:09 记录固定 ID inspect 等待 HTTP headers 超时；
最大宿主 poll gap 约 101.5ms、suspend 差约 13.7µs，该条是只读未知观察，
`unknown_write=false`。这些值不能单独解释 daemon 未返回的原因。

宿主 boot time 为昨日 17:35:23；guest 原 boot 的 journal 截至 17:29:19，
新 boot 从 17:58:03 开始。Colima 启动日志明确复用了原 platform 实例；
Docker 在 17:58:12–17:58:13 的 `Loading containers` 阶段对两个原 ID 记录
`layer not mounted` 与 stale sandbox 清理，恰与 FinishedAt 对应。
17:58:27 恢复器因异常 writer 结局阻塞，未自动重启 writer。
因此已证实宿主/guest 重启及 Docker 状态恢复窗口，不能把 FinishedAt 当作应用正常
排空时刻，也不能仅凭 255 推断 OOM。宿主为何重启、17:30 的底层停顿原因仍未知；
没有找到同期 panic 报告，宿主统一日志查询在原 15 秒读取期限内未完成。
旧 failure 分段的未知租约写入保留，不与这次 writer-exit 阻塞合并。

## writer 结局审查

重建前按两个原 ID 保存近 24 小时 `docker logs --timestamps` stdout/stderr，
逐行解析时间并读回校验文件大小、SHA-256 和权限，目录 0700、文件 0600。
producer 查询覆盖昨日 08:02:08–17:29:30，共 36,968 行；media 可用日志覆盖
08:15:57–16:49:54，共 108 行。没有正常退出尾部，因此明确保存异常中断边界，
不声称补到了不存在的 graceful shutdown 日志。原控制配置、激活记录、状态、
诊断及平台启动证据同时保全。

原库停机副本约 350MiB，与生产卷全部文件逐一比对大小和 SHA，一致。
保留原快照，再复制到隔离副本。直接只读打开原快照报“未正常关闭，需要 replay”；
在隔离副本中使用 Badger 原生恢复并明确 `WithTruncate(false)`，成功遍历全部值，
随后再次只读打开通过。恢复前后 value log 哈希一致，没有截断。
生产启动后再对原 value log 的全部 364,815,667 字节前缀核验 SHA，仍与不可变快照一致。
没有用副本替换生产库，也没有编辑 key、队列或历史。

审查读到 41 个 feed、3,449 个 episode；下载态 1,016、已清理态 2,433，
没有 new/error 状态。发布任务 2,071 succeeded，8 个原有 failed 均来自 9 月，
pending 为 0，历史失败不修改。原最后同步轮没有 feed/下载/上传操作，
待发送事件为 0；持久 next_sequence 为 30，与 D1 原 29 条唯一连续序列及累计计数一致。
新 guest 中旧 publisher 已不存在，媒体根为只读 tmpfs 占位，旧 NFS/传输不存在。
这些证据支持恢复原账本上的正常业务；没有重放无法判断结局的媒体任务。

## 正常重新准入

在原共享维护锁下卸载 Podsync owner。首先尝试只创建两个消费者，Docker 因只读
占位根下不存在 `.remote-media` 子目录而拒绝，两个旧 ID 均保持原状。
随后仅替换 writer，保留只读 media 原 ID；只创建、不启动、不启动依赖或第二 writer。
创建后的差异审查包括原镜像、入口、命令、挂载、只读凭据和 HostConfig。
Compose `--no-deps` 使自动元数据 `depends_on` label 为空，自动 hostname 也随新 ID
改变；这些差异及新 fingerprint 明确登记，没有改变业务依赖服务或源 Compose。

原异常退出、原状态快照和审查结论追加到 reviewed block/maintenance handoff，
再登记新 writer ID 与配置哈希。原 56 条 inspection 历史、全部 drain 账本、
人工许可、历史未知结果及自动预算保留；没有清状态、手设 ready 或手造租约。
控制器仍为平台 `7ce14e3`，观察 helper 仍为 `f591dea`，应用仍为 `9efb508`，
实际 v2 gate、全局 wrapper、完整 nonce ACK、boot/generation、wall/BOOTTIME 十秒 TTL、
两秒发布和原 SSH/观察期限均保持。

08:57:42 交接登记，08:57:46 由原恢复器完成新传输、介质身份、硬链接和 I/O 证明，
启动两个消费者并恢复 ready。此次仅使用原自动额度的一次连接。
生产原库由应用自然 replay，约 2.84ms；原值日志前缀保留。

## 生产验收

08:58:41 读回双 healthy、双实际 gate 0、RestartCount 0，单 Badger writer 和单 owner，
传输根句柄有效。应用二进制、source manifest、下载器和 ffmpeg 哈希均与原登记一致；
源配置/Cookie 哈希、mtime 和只读绑定保持。原始诊断继续保留，新的成功发布记录具有
guest 阶段、资源采样和 poll gap，已持久快照 dropped/write_failures 均为 0。

Mac、NAS 和容器源站的两个原最新样本及一个历史失败后恢复样本，分别为
14,384,055、18,392,046、59,424,894 字节；实际硬链接数均为 2。
两侧 RSS 200、enclosure 唯一、length/D1/源大小一致；媒体 Range 206/1024 字节、
总长和源前缀 SHA 一致。Worker 200/ok、媒体 healthz 204、Dashboard 原 Access 302，
TLS 验证通过。旧 NAS 间歇 TLS 原因没有因此被判定治愈。

应用按原持久事件机制将昨日 17:04:05 开始的中断轮闭合为 failed，errors_count 0，
追加一条“前进程未最终上报”的 warn；原序列与历史保留。这是进程中断结案，
不能将其当作新的节目失败。新进程已自然发现、下载并完整发布 feed，没有手动同步。
启动时 yt-dlp 自更新检查遇到 GitHub release API HTTP 403 rate limit，
形成两条 error 日志；现有已登记下载器未改变，随后自然下载成功，未手动重试或改版本。
成功下载只证明当前下载功能，自更新端点是否恢复尚未验证。

09:09:45 D1 读回，新进程已完整完成 28 个 feed、11 次下载、11 次发布及 11 次 report，
业务 errors_count 0，无重复发布组，所有轮次的 sequence 和累计计数一致。
恢复后最新两期为 19,075,536 和 24,019,524 字节，连同原失败后恢复样本，
再次通过 Mac/NAS/容器源站的 enclosure、大小、Range 与源前缀核验。
原 600 秒稳定规则自然释放自动额度，原连接记录仍在观察证据中，人工预算未变。
共享平台 31 组显式本地检查通过；本轮没有修改 Go 应用或控制器源码，
未重复执行完整 Go 测试。文档链接、JSON 登记和改动范围另行检查。

09:14:55–09:16:37 共享平台锁使租约按原十秒规则到期，恢复器进入 waiting。
初始稳定观察第 33 组后的实际门禁检查返回 75，随后两个消费者健康检查均为 unhealthy，
原失败保存在 `monitor-interruption.json`，前 33 组留在
`monitor-before-maintenance-lock.jsonl`。不能把它们称为连续二十分钟通过。
锁释放后原恢复器重新核验会话、介质和 I/O，自动恢复 ready，两个容器 ID/StartedAt、
RestartCount、56 条 inspection 历史和预算均未改变。该等待不是新的未知发布重试；
当时只读观测到两个 Python 进程打开锁文件，后续观测锁已释放，具体持有者工作未归因。
09:17:07 再次读回双 healthy/双 gate 0 后开始新的完整二十分钟观察。

09:37:08 完成恢复后的 1,201 秒观察，41 组完整 ACK/双时钟/boot/generation 证明、
82 次实际 gate 均通过；ready_since 保持 09:16:37，期间没有新状态转换或控制失败。
从 08:58:10 开始的总观察约 39 分钟，包含上述 102 秒 waiting；两段共 74 组完整证明、
148 次成功门禁检查，原失败单列保留。因历史锁持有工作未取得，本轮选择一次有限的
恢复后完整二十分钟窗口；这不要求将正常维护等待无限重置为新的故障演练。

09:37:48 的实际近 24 小时窗口按 run 开始时间纳入 9 轮，7 success、1 failed、1 running，
累计 234 feed、15 下载、15 发布、errors_count 0，序列去重与累计计数均一致。
failed 是原中断轮的既有结局；当前 running 为 08:57:45 启动的新轮，已完成上述
28/11/11，自然最新事件为 09:33:52，没有手动重跑或补写历史。8 月的旧 running
不在本窗口，未修改。所有只读 SELECT 的 rows_written 为 0。

同窗 producer 日志由已验证的旧 ID 归档 26,896 行与新 ID 3,429 行组成；
合计 info 30,305、warning 18（均为既有 Bilibili 不可用跳过）、error 2（同一次 GitHub
自更新检查的两条日志），fatal/panic 和远端事件上传失败均为 0。
当前窗口全部可用日志已保全、解析；旧已知 10 月 31 日 stdout 缺口已在窗口外。
昨日 17:29:30 至今日 08:57:45 无应用日志的停机/平台恢复时段及正常退出尾部缺失
仍明确保留，不能称为连续运行证据。

最终三样本 Mac/NAS/源站复核再次全部通过，Worker 200/ok、媒体 healthz 204、
Access 302 与 TLS 校验均通过，11 个新发布文件也逐一核对了源大小和硬链接。
最终双 healthy/双 gate 0、RestartCount 0、单 writer/owner、二进制与 manifest、
源 Cookie/配置哈希、mtime 和只读绑定均通过，原 56 条事故和历史未知结果保留。
新控制面持久诊断的 dropped/write_failures 仍为 0。
平台 current-release 仅更新 Podsync 的新身份、登记哈希和验收回执，其他服务改动保留。
本轮是运行恢复与登记修复，没有更改应用或控制器代码；宿主重启触发、原未知停顿、
锁持有工作及旧 NAS TLS 原因仍未确定，GitHub 自更新端点也没有恢复证据。

受限证据目录：
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-writer-exit-20261102/`。
