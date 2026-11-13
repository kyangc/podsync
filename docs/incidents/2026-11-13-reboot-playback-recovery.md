# 2026-11-13：宿主重启后的播放恢复

时间为 Asia/Taipei（UTC+8）。用户报告刚才无法播放，最初只读检查确认媒体返回 502；
用户随后明确授权恢复。沿用原 PersonalCloud 运行环境和媒体门禁。

## 原因与证据边界

宿主 loginwindow 在 16:52:12–16:52:13 记录 shutdownNoReturn 和等待关机/重启。
16:52:16，原恢复器的固定 ID 观察在 `unix_connect_begin` 后收到 FileNotFoundError，
Docker Unix socket 缺席；该条是只读观察，`unknown_write=false`。恢复器撤租并进入
`blocked`，当时原传输已经不能支持原会话重验，没有把它当作可直接重试的已准入会话。

宿主本次 boot time 为 16:56:42，Colima 在 16:59 复用原 platform 实例启动。
两个消费者均为 ExitCode 255、OOMKilled false、RestartCount 0、State.Error 为空；
Docker FinishedAt 同为 16:59:46。该时间是 daemon 恢复后的状态记录，不能当作应用
正常退出时刻。producer 最后一条应用日志为 16:48:51，没有正常排空尾部。
重启时的 SSH 连接拒绝也保留，但当前 SSH 配置已经更新，持续停机的直接原因是
原保护性阻塞及未审查的 writer 退出结果。

20:01 的实际播放请求为《孙富贵：资本在权力面前毫无还手之力》，Tunnel 明确记录
`lookup media ... no such host`：媒体容器未运行，无法提供源站。20:07 重测同一地址
仍为 502。原媒体文件存在，11,355,833 字节，与 RSS length 一致，硬链接数为 2。
Worker `/health` 200 只证明 Worker 活性，不能代表媒体可播放。

## 保全、审查与恢复

- 保存两个原 ID 的近 24 小时 stdout/stderr、完整 inspect、配置、激活、状态、
  原诊断与启动日志。逐行解析时间并读回大小/SHA-256；目录 0700、证据文件 0600。
  当前 producer 日志覆盖 10:38:17–16:48:51，之前的日志仍在上午 CI 发布归档中。
  没有补造正常退出尾部或停机期间日志，也没有把异常退出改记为正常排空。
- 保存停机库 tar，并读回全部文件；逐一比对生产 Linux volume 文件大小和 SHA。
  仅在隔离副本进行 Badger 原生恢复，明确 `WithTruncate(false)`；随后再次只读打开，
  全部值可读、计数和值一致，原 value log 未被恢复过程改写。没有打开原库进行审计，
  没有用副本替换生产库。
- 本地 pending publish=0、待发送事件=0；八项原有 failed 任务逐值保持。
  最后中断轮的九个事件、序号和累计计数与 D1 一致。持久 tombstone cursor=3485，
  远端为 3487；原 API 返回的后续变更留给应用自然处理，没有手动推进 cursor。
  云端配置与最后接受的缓存完全一致。所有 D1 审查均为只读 SELECT，rows_written=0。
- 核对旧传输不存在、guest 为只读 tmpfs 占位、没有活动数据库 writer 后，在原共享锁下
  卸载原恢复器并确认进程消失和 owner 锁可获取。仅创建同镜像的新 writer，不提前启动；
  原只读媒体容器 ID 保留。镜像、入口、命令、配置、挂载、只读凭据和 HostConfig 均核对。
- 追加原异常退出的审查结论与登记交接，保留全部历史、未知结果和连接预算；原控制器、
  helper、v2 gate、完整 nonce ACK、双时钟十秒 TTL、两秒发布与 SSH/观察期限不变。
  由原恢复器重新验证原卷身份、读写与硬链接，建立媒体传输并启动消费者。

20:51:39 原恢复器完成正常重新准入并恢复 `ready`。20:52 的双 healthy、双实际 gate=0、
单 writer、完整 ACK/boot/generation/双时钟 TTL 和内部健康检查通过。二进制仍为
`19ce1ae`，应用/source manifest/yt-dlp/ffmpeg 的实际哈希匹配上午登记；
源配置与 Cookie 的 SHA、mtime 和只读挂载保持。

## 交付验证

20:52:57 原失败地址返回 206/1,024 字节、正确 Content-Range 和 audio/mpeg，缓存 MISS。
Mac/NAS 两侧检查原失败节目及另外两份历史媒体，六次 RSS/Range 均通过：enclosure
唯一、RSS/D1/源大小一致、前缀 SHA 一致。容器源站也通过；原下载文件与发布文件均为
同设备/同 inode 的唯一对应硬链接。两侧 Worker=200/ok、媒体 healthz=204、
Dashboard=原 Access 302，TLS 校验通过。

原失败音频又验证开头、中间和末尾三个区间，返回字节均与源文件一致。
完整 HTTP GET 为 200，11,355,833 字节文件的整体 SHA 与源一致，完整音频解码无错误。
生产原 value log 的 435,971,985 字节旧前缀 SHA 仍匹配停机快照。
恢复器相关的 71 项隔离回归通过，没有执行真实宿主故障注入。

恢复后的首轮处理了 28 个 feed：26 个完整更新成功，`wangxiao` 和 `zaixiadaoge`
分别在 20:52:54、20:53:04 返回 Bilibili API“服务调用超时”。它们是上游发现失败，
现有音频交付仍正常；保留这两项真实错误并沿用原调度，没有手动重放整轮。
五个新节目各有唯一一次发现、下载、发布与上报，没有节目终态错误或重复发布组；
按原五分钟 publisher 周期在 20:56:42–20:56:45 自然发布完成。五份新媒体的 Mac/NAS
十次 RSS/Range 与容器源站检查均通过，首次双侧请求均为 MISS。

20:59 的在线库文件复制前后，文件集合/大小/mtime/inode 相同；仅在隔离副本完成
无截断原生恢复及只读复核。cursor 已自然到 3487，两项原远端变更的持久标记逐字段
一致，pending publish/outbox 仍为 0，八项历史 failed 逐值保留；本地 next_sequence=86
与 D1 已接受的唯一连续序列 1–85 及累计计数匹配。

原中断轮由应用自然闭合为 failed，errors_count=0，追加“前进程未最终上报”的 warn；
该事件表示进程中断结案，不能混作本轮新节目失败。启动时 GitHub release API 的
403 rate limit 仍使自更新检查失败，已登记下载器未变；本轮真实下载均成功。
另一次 YouTube 媒体 HTTP 403 按原预算自动重试后成功，没有终态节目错误。

20:53:15–21:03:16 完成 601 秒连续观察，31 组完整 ACK/boot/generation/双时钟 TTL
证明和 62 次实际门禁全部通过。原 ready_since、两个消费者会话、RestartCount 和
事故历史均保持，没有新的控制失败；原控制器在 ready 满 600 秒后自然释放自动连接
窗口，未人工清预算。最终再次核对双 healthy/双 gate=0、单 writer/owner、内部健康、
实际制品哈希、源输入和有效 NFS 根均通过。平台 current-release 仅更新 Podsync
新 writer 身份、恢复配置哈希及本轮验收证据，其他 stack 和原应用发布登记保持。

本次是运行恢复与消费者登记交接，没有修改 Go 应用、镜像或控制器代码。
异常 writer、未知写入和耗尽预算仍保留原审查要求。计划重启应先由原恢复器完成正常
排空，确认原消费者退出 0、租约撤销和挂载收尾，再停止宿主；不能以清除 `blocked`
代替这一步骤。当前应用异常退出的具体终止信号及关机请求的触发者没有据本次恢复定论。

受限原始日志、数据库快照、请求与验收证据位于
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-playback-recovery-20261113/`，
不写入 Git。恢复文档与生产消费者登记分别保存在对应仓库；线上应用仍为本轮
已验收的 `19ce1ae`，部署对应关系以平台 current-release 和实际容器读回为准。
