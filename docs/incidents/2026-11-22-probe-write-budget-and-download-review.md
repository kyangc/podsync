# 2026-11-22：探针写前预算、原生租约存储与下载复核

时间均为北京时间（UTC+8）。本次处理的是 11/21 08:17 的新事件，发生在
[11/21 旧复核](2026-11-21-youtube-format-media-deadline-and-config-eof.md)收尾之后。
旧记录的 ready、零控制失败不适用于本次 blocked。

## 原故障及可证明的提交边界

原恢复器 approved，但 phase=blocked；两个原消费者 running、Docker unhealthy，
两个真实 v2 gate 均 exit 75。Linux 租约不存在、ACK 为零。应用内部健康和已发布
媒体仍可用，因为撤租和健康检查不会追溯终止已运行的业务进程；这不代表门禁通过。

以下是一次因果链，不能按日志行数算四个独立故障：

1. 11/21 08:14:24.748：固定 ID inspect 超时，只读结果未知，unknown_write=false。
2. 08:14:55.546：进入 checking；随后原会话与媒体重新验证，08:14:58.444 ready。
3. 08:17:25.829：媒体探针 SSH 七秒超时，unknown_write=true。
4. 08:17:32.759：周期记录 blocked；state 更新时间为 08:17:25.847。

原探针宿主调用始于 08:17:18.592；guest 公钥认证直到 08:17:23.448 才出现。
首条 guest 进度在宿主调用后约 4.978 秒收到，之后收到 session、listing、
write_fsync、hardlink、rename_read。未收到 cleanup 或 complete。
宿主连续时间与单调时间相差约 11 微秒，墙钟差也仅微秒级，不支持该七秒窗口由
宿主休眠或时钟跳变造成。采样宿主负载升高；没有足以唯一定位触发者的调度、
原 SSH 逐阶段或 NFS syscall 跟踪，不能归责某个进程、磁盘事务或内存故障。

原媒体根保留一组 `.linked` / `.done`，各 8,192 字节、同 inode、链接数 2，
宿主与 guest 内容 SHA-256 一致，mtime 位于原窗口，`.part` 不存在。
原调用的 hardlink、rename_read 进度直接证明写入/fsync 与硬链接校验已返回。
原程序没有记录随机文件名或预期数据哈希；这组唯一残留与命名、大小、精确窗口、
单 owner 串行调用及阶段一致，支持 rename 部分提交的归属判断，不能补造原 nonce
或原读回回执。
原 read assertions 是否完成仍未知；cleanup 没有完成，不能把这次探针改写为
“未提交”或“已成功”。两个残留原件保持原位置，另保存受限证据副本。

原 guest session-60024 在 08:17:25.776 关闭 SSH，sudo 于 08:17:28.529 关闭，
scope 随后退出；当前没有原探针或 publisher 进程。guest 会话终止证明没有迟到
writer 仍在运行，不补造原读取/退出成功回执。全部原 state、diagnostics、阶段、
未知结果、预算和历史先行保全。

## 修复机制与受控重新准入

确认的控制缺陷是：旧路径把新建 SSH 的耗时计入宿主七秒期限，却允许 guest 在
建连后立即开始一个独立五秒期限的写探针。本次启动耗掉近五秒后，写探针仍获准
开始，宿主随后在 rename/read 区域切断 SSH，造成部分提交及永久未知阻塞。
底层延迟的具体责任方仍未知；修复针对已复现的预算错配，不宣称消除所有 I/O 停顿。

平台源码 `8dfe942` 为 Podsync 增加显式启用的 `probe_preflight`：

- guest 在任何媒体读取或写入前等待完整 nonce-bound 指令。
- 宿主只在原七秒总预算仍有六秒余量时发送 proceed；否则发送 abort。
- 仅完整匹配的未开写回执、SSH exit 0 和本地清理确认共同构成 ProbeNotStarted。
  已准入且身份未变的会话可沿原最多三次观察规则有限重验；不会重连或重启消费者。
- guest 拒绝迟到的 proceed。任何缺失/错误回执、非正常退出或超时仍 blocked，
  即使已收到 complete 或未开写的进度，也不能把未知 SSH 退出当成功。
- 原 ConnectTimeout=3、宿主 probe=7、guest timeout=5、发布预算=2 秒及双时钟
  TTL=10 秒保持；原恢复额度、历史及未知结果保留，不添加人工额度。

隔离回归在旧代码下失败，并复现延迟后留下 `.done/.linked`；新代码在相同延迟下
确认未开写、没有媒体副作用。另覆盖三次上限、缺失回执、迟到 SSH 退出、已开写
超时不重放及成功后恢复。平台显式完整检查 38 组命令通过，相关 Python 回归
138 项通过；原 Linux arm64 应用镜像的无网络、只读、临时根隔离容器又通过
14 项探针测试。默认 Python 缺 PyYAML 的首次检查失败已保留；改用仓库现有隔离
环境后完成检查，没有修改宿主依赖。

先核对并协调活动 Monga 维护；生产操作只涉及 Podsync 登记路径，并持原共享
维护锁。通过既有 drain 方法正常排空两个原 ID，均 exit 0、非 OOM；正常卸载
旧 NFS 后卸载原 launchd owner，确认 owner 锁可获取、旧 transport 消失、离线只读
占位挂载存在。原 ID 的完整近 24 小时 stdout/stderr 归档至正常退出，逐行核对
时间、完整尾部、大小与 SHA-256；停机数据库 tar 全部文件完整读回。

在 owner 锁及共享锁下追加 reviewed block/handoff，仅更新 Podsync 专属冻结制品、
config/activation 摘要与守卫启动入口。新制品目录为
`runtime/control/media-recovery-podsync-preflight-8dfe942-20261122/`。
原 v2 gate、helper、transport 字节、应用镜像、容器 ID/配置指纹、源配置与 Cookie
保持；源输入哈希、mtime 与只读绑定复核通过。没有手造租约、清预算、清队列，
没有第二个业务 writer、旧 VM/NAS writer 或 USB 媒体 VirtioFS。

11/22 08:15:39 原恢复器完成新 NFS/session 的身份、读写、fsync、硬链接、rename、
读回及完整租约准入，再启动两个原 ID。08:16 生产读回为 ready、双 healthy、
双真实 gate=0，完整 nonce ACK、boot/generation 和双时钟十秒 TTL 均匹配。
实际 `/app/podsync`、source manifest、yt-dlp 和 ffmpeg 哈希仍匹配原 `6a66af4`
发布登记。唯一数据库消费者和唯一控制器保持。

08:16:16–08:36:17 完成 1,201.6 秒连续观察，41 次完整租约证明和 82 次实际 gate
全部通过；两个消费者持续 healthy，ready_since、容器会话、RestartCount 和原历史
保持，没有新增控制失败或非 ready 周期。08:25 后原自动连接窗口按既有 600 秒
规则自然释放；本次一次连接仍保存在准入回执及连续观察记录中，没有人工清预算。
原两个探针残留的 inode、大小、mtime 与内容哈希在重新准入后再次核对保持。
八项历史失败完整值与 11/13 留档逐值相同。后续自然新媒体观察继续记录。

延长观察在 09:08 左右捕获一次实际 gate=75，而 phase 仍为 ready；随后直接复测
双 gate 通过，不能据此消除原拒绝。对原 producer 的 1,000 次有界只读实际 gate
采样又在 09:15:37 复现一次，耗时约 8.8ms：之前租约仍余约 8.7 秒且完整 ACK
匹配，之后已切到新 nonce、ACK 尚不可见。它位于正常换约窗口，不是已证明的
TTL 到期或两秒读取预算耗尽。保留两次失败，不能把最初二十分钟窗口扩展成
“全程全部 gate 均通过”。首次延长观察没有逐 syscall 现场，具体拒绝点不能补写。

## 实际 gate 的续约拒绝与原生租约修复

随后在原 producer 的实际 mount/pid namespace 内，跟踪原版 gate 的真实 syscall。
09:27:06 的复现显示：首次 `lease.json` 读取完整，boot 身份和 NFS session proof
匹配；第二次打开同一路径时直接返回 ENOENT，约 12ms 后 exit 75。仍在双十秒
TTL 内，没有达到两秒读取期限。可替换的租约文件位于 VirtioFS 只读绑定中，正常
atomic replace 在 guest 消费端短暂呈现缺失。该跟踪确定了复现窗口的失败点，
不冒充 09:08 首次失败当时没有记录的 syscall。

隔离对照中，Linux 原生文件替换并发读正常；VirtioFS 的交换替代方案在并发只读
绑定下也出现权限错误，不能作为可靠修复。隔离错误不计入生产故障次数。
因此平台源码 `4eee924` 仅为 Podsync 增加原生租约发布：

- 可替换的 `lease.json` 位于既有 Linux VM ext4 的独立本地卷
  `podsync-media-lease`，两个消费者在原门禁路径只读挂载；业务媒体仍走原 NFS。
- guest 创建 `ack-<nonce>` 到只读宿主 ACK 目录的链接，完整发布回执仍须逐字段
  匹配原宿主授权且在原两秒发布预算内。仅链接和候选租约不能授予权限。
- 宿主收到完整回执后才写入对应完整 JSON ACK；撤销只删除宿主 ACK，不重试远端
  未知写入。旧宿主 ACK 在满原两秒读取预算后的发布清理中回收，不延长租约有效期。
- Docker 原父目录权限不变；固定 native path 的 SSH publisher 使用既有非交互
  sudo。启动校验要求登记的 local volume 路径、v2 stream 和至少一秒的轮询周期。
- 原 gate 二进制、boot/generation 校验、双时钟十秒 TTL、两秒读取期限、观察次数
  上限、自动/人工连接预算均保持，未添加旁路、手造 lease 或额外人工额度。

首次 native 卷预检查因 Docker 父目录权限拒绝而中止，尚未发布租约、改 Compose
或启动业务。保留刚创建的本次专属卷并核对为空，修正为既有非交互 sudo 后，
重新完成最终完整回归和隔离协议验证；没有改 Docker 父目录权限或清除未知内容。

新增七项原生发布回归，覆盖完整 ACK、撤销、旧 ACK 读取预算、未知发布不重放、
错配回执、缺卷和配置拒绝。最终显式本地检查 38 组命令全部通过，相关 Python
回归共 145 项。实际 arm64 应用镜像的无网络隔离 fixture 使用真实 guest publisher、
原 gate 和隔离挂载完成 101 次发布、1,210 次 gate 检查，零失败；撤销宿主 ACK
后即使原生候选租约仍在，gate 仍 exit 75。未挂生产数据库、媒体或凭据。

切换先通过 Podsync 专属 pause 让现有 owner 正常排空，两个原 ID 均 clean exit 0；
原 ID 日志再次归档至本次退出、完整回读并哈希，第二份停机 DB tar 也完整回读。
只读原库全部值可读：cursor=3793、succeeded=2459、八项 failed 完整值不变，
pending publish/outbox=0。没有从旧库恢复，没有清除任务或队列。

新增只读租约挂载必须重建两个消费者。为让 Docker create 正常解析既有媒体
子目录，先使用既有方法记账一次 staging 连接、正常挂载并完成原媒体探针，
仅 create、不启动业务、不发布租约；随后正常卸载并关闭 transport。
共享维护锁实际持有约 1.8 秒。新 ID/指纹和配置摘要重新登记，追加 handoff 并
保留全部 reviewed block、drain、inspection、人工额度历史。再由新 owner 正常
准入，自动预算记账第二次连接，应用与 media 镜像、源输入和 Cookie 保持。

当前冻结目录为 `runtime/control/media-recovery-podsync-native-4eee924-20261122/`，
config SHA-256 为 `b17489eba6ac1d7a3435e95034aa34861552bd32904ac28210e7fb647f02c5ec`。
09:57:22 新消费者正常准入，首轮核对双 healthy、双实际 gate=0、完整宿主 ACK、
boot/generation 和双时钟 TTL 通过。原未知探针残留和失败采样继续保留。
09:57:54–10:17:55 完成独立 1,201.7 秒生产窗口：41 次完整租约/boot/session/
双 TTL 证明和 82 次实际 gate 检查全部通过，持续双 healthy、零重启、零新增
控制失败或非 ready 周期。另有 producer 3,000 次、media 2,000 次真实 gate 续约
采样零失败；原版 gate 在两个实际容器中的 SHA-256 均仍为
`0bf25f5830cd228c3becd873271597b529673129122d4d9d28b8556be3921dce`。
两次连接按原 600 秒 ready 规则自然释放，人工额度记录仍为原三项。
原八项 failed 的完整值与原库逐值一致，原未知探针残留的 inode、大小、时间和
内容哈希未变。当前控制恢复与实际交付验收通过，保留原未知结果和延迟归因边界。

## 七个原失败节目的独立复核

12 次终态来自七个新节目，表内标签只用于本次受限身份映射：

| 样本 | 原失败 | 后续实际交付大小 |
| --- | --- | ---: |
| A | YouTube extract 格式不可用 1 次 | 60,890,292 |
| B | YouTube extract bot 登录确认拒绝 2 次 | 15,845,436 |
| C | YouTube extract bot 登录确认拒绝 2 次 | 15,957,703 |
| D | YouTube extract bot 登录确认拒绝 1 次 | 13,094,709 |
| E | YouTube extract bot 登录确认拒绝 1 次 | 16,348,052 |
| F | YouTube extract 格式不可用连续 4 轮 | 168,857,764 |
| G | Bilibili media 无数据块 1 次 | 13,483,764 |

bot 六次均单次约 2.6–3.6 秒，metadata=false，原输出明确要求登录确认。
格式五次约 4.4–6.8 秒，同样未得到下载 metadata。F 从首次发现至最终 report
约四小时九分，是真实交付延迟，不能因后来成功抹去。A/F 后来自然下载、上传、
上报；原失败时没有完整可用格式/player 响应，不能倒推为直播处理延迟。

G 原媒体阶段耗时 29,523ms，明确 `Did not get any data blocks`；下一轮于
11/22 00:46:53 下载完成、00:51:44 上传、00:51:45 上报。它与两个既有 Bilibili
discovery -404 样本的 48 次跳过分别计数，不合并成 49 个新增 Bilibili 问题。
没有原 CDN 字节流和逐请求记录，无法唯一归责无数据块的底层断点。
bot/格式失败发生在提取阶段；G 的媒体下载临时目录在原 Linux `podsync-tmp`
volume，尚未进入 NFS 发布复制。原输出和阶段不支持把这些失败统一归因于
08:17 的控制探针；控制面 blocked 与实际媒体交付分别验收。

08:17 在真实 Linux producer、原出口、原 yt-dlp 2026.10.26 及实际 mweb 配置下，
对六个 YouTube 原样本做 simulate/skip-download、禁用磁盘 cache 的只读提取。
B/C/D/A/F 当前 player=OK，原选择器选 format 18。复核发现沿用的取证 helper 只改
`params['format']`，没有重建 yt-dlp 在初始化时缓存的 `format_selector`；本轮修正
helper 后重新比较 C/A/F：A 的两种选择器都选 18，C 的 `bestaudio/best` 选 251-1
纯音频，F 选 251 纯音频。F 当前报告的源大小分别约 779MB/205MB，但本次只提取
metadata，没有验证替代流的完整下载，也没有原失败时的格式快照，不能据此断言
它当时能消除四轮失败。保留初次与修正后的取证，不基于错误对照或当前快照修改
生产选择器。11/21 两个旧样本当时都仅提取到 18 与 storyboard，不能把本次 C/F
的纯音频可用性倒推到昨日旧样本。

E 当前 player=UNPLAYABLE，明确会员专属；它与昨日 bot
提示不同，不能倒推原失败原因。没有新增媒体下载、发布或获取浏览器凭据。
现有配置仍无 YouTube Cookie/浏览器 Cookie，会话对照缺口保留；当前匿名限制
不能宣称全部解除，也不为此阻塞独立的本地控制面修复。

## 持久状态与交付证据

原停机库经只读 Badger 审查：全部值可读、cursor=3790、outbox=0、pending publish=0，
保留原八项历史 failed。原 494,539,199 字节 value-log 离线解析通过 901,293 条记录
CRC32C、446,784 个事务及提交标记，无未提交尾记录，没有打开运行库或第二个锁。
七份发布状态均 succeeded/visible、attempts=1、last_error 空，大小及资产身份匹配 D1；
发布 attempts 不冒充下载尝试。全部原发现、失败、下载、上传、report 事件逐字段
匹配持久提交，且有后续 ACK 后移出待发内容的边界，原失败历史保持。

08:16 独立再次核对七份原媒体及最新 YouTube 27,203,805 字节，共八份：
Mac/NAS 十六份 RSS 均 200、原 enclosure 各恰一条、length 等于 D1；十六次 Range
均 206/1,024 字节、总长匹配，双方前缀哈希等于物理源文件。源大小匹配，各 feed
目录恰一份同设备/同 inode 硬链接。两侧 Worker=200/ok、媒体 healthz=204、匿名
Dashboard=原 Access 302、TLS 校验通过。交付成功不替代恢复器与门禁验收。

最初独立读取 11/21 08:00 至 11/22 08:12 的原会话 stdout/stderr 89,880 条，
fatal/panic=0；12 次终态对应 24 条执行错误/输出和 12 条 summary，另 48 条旧
Bilibili 跳过。没有 feed、上传、report、远端事件或配置最终失败。
D1 只读查询 rows_written=0，近 36 小时各轮 sequence 从 1 唯一连续，累计与事件匹配。
08:18 读回原进程末轮已于 08:13:07 正常 success（28 feed/1 下载/1 上传/0 错误）；
08:15:39 的第一新会话完成 28 feed；之后 09:15:43 的正常小时轮发现一份新媒体
N1（YouTube，15,943,154 字节），09:17:36 下载、09:20:42 上传、09:20:43 report。
发现、下载、上传、report 各一条，未出现下载终态失败。只读 value-log 逐事件
对账确认持久提交及后续 ACK 移除；发布 succeeded/visible、attempts=1，原八项
failed 仍在。此自然新媒体发生于原生租约切换前，不移作切换后新下载的证据。

09:59 原生租约切换后重新从 Mac/NAS 验证七个原样本、旧最新样本及 N1，共九份：
十八份 RSS 均 200、enclosure 唯一且 length 匹配 D1，十八次 Range 均 206/1,024
字节、总长和前缀哈希匹配源文件，各源均有唯一同 inode 硬链接。两侧 Worker
200/ok、media 204、Access 302 和 TLS 校验通过。切换后的自然 feed 轮与最终
控制观察单独记录，不将 running 状态计为完成轮。

原生租约切换后的自然更新又发现 N2（Bilibili，4,734,841 字节）：09:58:22 发现、
09:58:28 下载、10:02:26 上传及 report，各一条。当前进程完成 28 次 feed 更新，
累计 1 下载、1 上传、0 错误。D1 的进程 run 正常保持 running；它在服务退出时
才记录终态，不能为了得到 success 状态额外重启，也不能把 running 冒称已关闭。
新进程序号 1–69 唯一连续，所有事件逐字段匹配本地已提交值及后续 ACK 移除；
计数与事件一致，pending events=0。对运行库只读固定长度 value-log 前缀，未打开
Badger 或第二个锁：495,409,823 字节、902,582 条 CRC32C、447,426 个提交事务，
无未提交尾记录。N2 发布 succeeded/visible、attempts=1，succeeded 总数增至 2460，
原八项 failed 保持。10:04 Mac/NAS 的 N2 RSS、Range、TLS、源大小与硬链接、
前缀字节全部通过，补齐切换后自然新媒体的实际交付。

10:18 窗口结束后的首次固定前缀快照恰好包含 5 条正常待上报事件，早于既有一分钟
flush；逐事件断言因此没有通过，原快照与查询保留。未手动 flush 或重放任务，
等待原周期后在 10:18:58 重新只读采样：495,429,007 字节、902,660 条 CRC、
447,465 个提交事务、无未提交尾记录。最终序号 1–84 唯一连续、逐条匹配持久值
和后续 ACK 移除，pending events=0，计数仍为 28/1/1/0；没有把正常在途状态
删清或将前次检查失败改写为通过。10:18 新媒体 Mac/NAS RSS、Range、源字节与
TLS 最终复测再次通过。本次共验证十份身份互异的原/新媒体。

最终回执为 `runtime/private/podsync-recovery-20261122/final-acceptance.json`；
平台发布登记同步到实际 `4eee924` 冻结制品、当前配置摘要和新消费者身份。

受限原始身份、日志、停机库、探针残留副本、D1、逐事件对账、Linux 回归、双侧交付、
部署与连续观察证据位于 `runtime/private/podsync-recovery-20261122/`，目录 0700、
文件 0600，不进入 Git。原未知读取结果、残留与原随机文件名的直接回执绑定、
具体延迟触发者及 YouTube 登录态对照仍有边界。
