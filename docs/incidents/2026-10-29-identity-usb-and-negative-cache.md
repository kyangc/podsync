# 2026-10-29：身份观察复发、真实 USB 失盘及媒体负缓存

时间均为北京时间（UTC+8）。本轮处理实际生产 Mac mini Colima `platform`，
运行目录为 `/Users/chengkangyang/DockerPlatform/runtime`。
前一轮的 [20 分钟记录](2026-10-28-recovery-control-plane-root-cause.md) 不能作为此次正常基线。

## 已确认的故障链

- 10 月 28 日 13:42:07/13:42:12 两次身份观察未知后曾恢复；13:43:17–13:43:30
  连续三次未知后进入 `blocked`，一直没有恢复。10 月 29 日 08:00 核实两消费者仍在运行，
  但 Linux 租约缺失，两个实际门禁均拒绝。Podsync Docker unhealthy，媒体 nginx 的静态 healthz 仍通过。
- 10 月 28 日 17:17:46.891，内核记录 Realtek RTL9210 USB 桥因 `link change interrupt`
  被销毁；17:17:47 磁盘移除、APFS 报介质不在场，并撤销 4T 卷。
  DiskArbitration 同时记录原登记 UUID 和 `/Volumes/4T/`，17:17:50.475 完成同卷重挂。
  这建立了真实 USB 链路丢失的证据，不能再只归因于管理观察超时。
- 本次读到旧 unfsd 进程仍在监听，但工作目录不可读、固定根目录描述符为 `(revoked)`。
  宿主当前文件可读；guest 挂载和两个容器媒体根均报 EIO。
  已 blocked 的控制器不再执行 I/O 探针，因此也没有处理这次后来发生的真实失盘。
- 第一条业务失败出现在 17:19:48；420 个 `feed_update_failed` 覆盖全部 28 个 feed，
  最近完成的三轮都是 0 feed / 0 download / 0 upload、各 28 error。
  另有 137 条 stat error，属于同一批失败的日志层表现，不能再加到 D1 的 420 上。
- `/health` 使用 builder 在 discovery 时写入的 `Feed.UpdatedAt`。
  API 元数据继续成功、XML/OPML 和文件访问全部失败时，该字段仍刷新，因此内层健康误报 200。
- 最新旧节目真实文件为 16,571,141 字节，硬链接数 2，D1 和 RSS 长度相同。
  修复前 Mac/NAS 对同 URL 出现 206 与 404/HIT 差异；恢复源站后，两侧也曾同时命中旧 404。
  nginx 对 404 同样添加 public/max-age/SWR，是负缓存持续存在的直接配置原因。
  浏览器管理台确认没有 Cache Rules，区域 Browser TTL 为既有 4 小时；没有将其误称某条覆盖规则。

13:43 的原始分段计时已被日常轮转覆盖，本轮无法唯一确认那三次分别卡在进程启动、
DiskArbitration IPC 还是宿主调度。前一轮保留的样本确实定位过 diskutil 阶段和观察器启动阶段。
17:17 的 USB 链路事件已确认，但线材、供电、硬盘盒或驱动中的具体触发因素仍未区分。

## 修复与受控交接

平台修复 `e2ae2a0` 为 Podsync 登记 `identity_backend = "native"`。
暖驻 worker 每轮通过 Darwin `getattrlist` 读取实际卷 UUID、挂载点、只读标志，
再核对挂载、真实路径、设备和符号链接。移除每轮 diskutil 启动和 DiskArbitration IPC 依赖，
不缓存 true；系统调用失败仍按未知处理，错误 UUID、挂载点和只读卷仍拒绝。
原三秒观察期限、三次连续未知上限、租约/SSH/门禁预算均保持。

应用修复 `63525c0` 增加独立的持久化完整发布成功时间。
只有下载处理、XML 和 OPML 均完成后才记录；discovery 原子保留旧成功时间，
不能凭 builder 输入建立成功记录。旧记录在第一次完整更新前保持未就绪。
两个消费者的 Docker 健康检查都先执行真实 v2 门禁，producer 再读取应用 `/health`。

08:13:24 开始正常排空；两个消费者均退出 0，未 OOM。08:13:26 正常卸载旧 NFS，
再停止旧 owner 和失效传输，复制停机 Badger 数据库至受限证据目录。
首次 create 使用了当前 Compose 不支持的 `--no-deps`，在创建前失败；错误保留。
修正后 dry-run 确认只重建两个消费者，provider 和 tunnel 保持原身份。
08:14:36 重新登记，08:14:40 原恢复器完整准入并进入 ready。

登记保留原三次自动连接记录、旧 blocked 事故和已用人工许可。
按本告警既有授权，仅登记一次有原因和唯一 ID 的额外传输许可；新连接在启动前记账，
没有提高 `max_attempts` 或手工清空预算。原有十分钟稳定后恢复自动额度的规则照常执行，
旧记录另保存在交接历史和不可覆盖的停机快照中。

运行镜像为 `sha256:61e1460c5004c4eab12588ce6469238487f8a84531fb4966eb0bd77bd9e5cbaf`，
使用 Go 1.25.8、锁定的 go.mod/go.sum 构建 Linux arm64 二进制，嵌入完整源码 commit。
镜像沿用原固定运行镜像，仅替换二进制并加入源码摘要清单，避免在恢复中一并更换运行依赖。
源码、构建回执、二进制摘要和原镜像保留，可按同一排空/登记流程回退。

媒体配置修复 `d066ef2` 使非成功响应 `Cache-Control: no-store`，正常媒体继续缓存。
真实隔离 nginx 在修复前复现 404/public，在修复后验证 200/cacheable 与 404/no-store；
生产配置通过 nginx -t 后平滑 reload，媒体容器没有再次重建。
公开不存在对象连续两次 404/no-store/BYPASS，两次均未缓存。

Wrangler OAuth 能只读 D1，但区域缓存读取为 403；现有 Chrome 登录可以查看管理台。
先完成真实文件和容器内 Range 验证、修复源站缓存策略，再仅对已证实的那个旧 404 URL
执行一次“自定义失效”（标为过时以重新验证）。没有全区 purge、开发模式、共享规则或 TTL 修改。
操作范围截图、旧 404 响应和失败的首次重验全部保留。

首次软失效后的 Mac 仍收到一次 404/UPDATING；NAS 已 206。
后续 Mac 在冷缓存回填时出现 30 秒媒体/healthz 超时，源站已经记录完整 200/16,571,141 字节。
当时 Tunnel 4 连接、在途 2、历史错误 5，goroutine 可见 HTTP/2 response writer 等待。
停止新增回源探测后在途自行归零，历史错误仍为 5；Mac 原地址再读 206/1024，healthz 204。
本轮未为此重启 Tunnel；这些短暂失败不被后续绿色结果覆盖，也不足以唯一定位 HTTP/2 背压的底层触发。

## 验证与数据边界

100 次真实 native worker 只读采样全部有效，中位 0.156 ms，含启动最大 51.603 ms。
20 组交错对照中，native syscall 中位 0.116 ms，diskutil 中位 78.247 ms、最大 820.340 ms；
当前对照没有超时，不能冒充复现了历史全部延迟。
回归覆盖 native 未知与真实错误身份、三次未知撤租且不新建连接、原 nonce 全字段确认、
迟到 writer、原十秒到期、未知写入和新会话拒绝。真实 Linux 隔离协议 13 项全部通过。

`go fmt ./...`、`make test` 和 lint 通过。
已有 lint 由 Go 1.26 构建，默认 Go 1.27 会 panic；限定该命令使用 Go 1.25.8 后 0 issues，
没有更换全局工具链。Go 1.25.8 全套测试也通过，源码 commit 的 CI 与 Nightly 均通过。
平台原标准入口 27 条通过；补充三连 native 边界后重新运行聚焦回归。

08:28 的全量只读核对为 512 个 visible 对象：真实文件全部存在、大小全部与 D1 相符。
494 个文件链接数 2，18 个链接数 1；后者的已发布文件仍存在且长度相符，不把链接数 1 当成内容丢失。
此核对验证存在性和长度，不代表所有历史媒体均做了完整字节校验。
四个原样本额外在容器内验证大小、硬链接、Range 206/1024 及源前缀 SHA-256 一致。
旧 NAS 的 Docker daemon 无法连接，进程清单无 dockerd/containerd/Podsync writer；
当前平台 `podsync-db` 只有一个运行 writer。未启动旧 VM 或 NAS 服务。

源 config/Cookie 的 SHA-256 和 mtime 多次读回一致，容器仍只读绑定。
9 个当前/归档日志去重得到 559 条 error：420 条 feed、137 条 stat，以及同一次已知旧下载失败的两条 stdout error；该旧下载在 D1 是一条已恢复事件。Bilibili 不可用 warning 为 58，fatal/panic 为 0。重建交接时段仍存在未完全核实的 stdout 覆盖缺口，
不能把当前实例日志当作完整 24 小时记录。420 个 feed 错误不再重复加总，
昨日 11:11:27 的旧登录错误及恢复记录保留。

## 最终固定窗口和业务读回

固定窗口为 08:15:44–08:45:44，未因中途样本重置。
361 个五秒样本均为 ready，观察事故维持 50 条；121 轮双消费者实际门禁共 242 次，全部通过。
原始 lease/ACK/双时钟快照 360/361 有效；08:41:54 一次读取返回 FileNotFoundError。
该原始采样未保存缺失文件路径，不能唯一指认 lease 或 ACK；08:41:44 和 08:41:59
的四次实际 gate 均通过，当时没有同时执行 gate，不能把该快照冒称门禁失败或全部有效。
最终再次读到完整 nonce ACK、原十秒双时钟期限、generation 匹配和两门禁通过。
保留的窗口计时中，921 次完整 native 观察全部成功，中位 1.239 ms、最大 53.759 ms；
它们是保留并去重的计时记录数，不冒充所有已执行周期的总数。

08:46 的只读 D1 核对为 10 月 28 日 08:00 起 30 个 run、3,498 条事件，
每轮 sequence 连续且与累计 feed/download/upload/error 计数一致。
全部 28 个原失败 feed 均已在最后一次失败后成功；新 run 为 28 feed、20 download、20 upload、0 error。
20 个节目逐一核到 download/upload/report 各一次，均已闭环。
当前小时 run 仍 running、最新事件为 08:44:48，没有把正常未到期 run 判成卡死或手动结束。
全部 27 次 D1 只读请求均核 rows_written=0；旧 420 个 feed 失败原样保留。
08:16:18 一次新的媒体读取超时有两条 stdout error，按原机制于 08:17:30 第二次尝试成功，
随后发布和上报完成，没有把它们误算为两个新增终态业务错误。

四个原样本加最新节目共五组，最新为 11,123,556 字节。
最终 Mac/NAS 十次 RSS 均 200、enclosure 各唯一且长度正确；
十次原媒体地址均 HIT/206/1024 字节，Content-Range 总长与 D1 相同，前缀 SHA-256 与真实源一致。
容器内五组同样通过，硬链接数均 2。
Worker 两侧 200/ok，媒体 healthz 204（约 1.466/1.062 秒），dashboard 302 到 Access。
Tunnel 最终 4 条连接、在途 0、历史错误计数 6；窗口后段 08:41:21 新增一条 client disconnected，
对应 control stream context canceled 日志保留，不把重验失败或计数增长隐藏成零错误。
本轮没有重启 Tunnel。

两消费者 healthy、RestartCount=0，StartedAt 保持本轮一次准入后的值，容器登记与指纹一致；
新 unfsd 的固定根描述符有效，唯一 Badger writer 为 podsync。
实际应用二进制、镜像 source label、源码清单、controller/gate/config 摘要均对上已提交制品。
源 config/Cookie 的宿主/容器摘要、只读绑定及 mtime 复核通过。
标准平台入口最终 27 条及聚焦 68 项通过；源站缓存修复保留修复前失败和修复后真实 nginx 检查。


完整受限证据位于
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-identity-recurrence-20261029/`。
未打开运行中 Badger、清 outbox/历史错误、手造租约、放宽预算、修改 Access/TLS，
也没有手动删除媒体或进行文件名迁移。业务原有的保留策略随正常调度继续执行。
