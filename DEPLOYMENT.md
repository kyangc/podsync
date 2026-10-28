# 运行与部署约定 · 2026-10-25

## 当前状态

生产 stack 目录为 `/Users/chengkangyang/DockerPlatform/runtime/stacks/podsync`。
数据库和临时状态位于内置盘 Linux volumes；媒体仍为 `/Volumes/4T/PublishedMedia/podsync`。
用户现用订阅域名为 `podsync.kyangc.net`，原 `router.kyangc.com:9092` 已关闭。

NAS producer 和媒体容器已停止；不要用旧 NAS 容器检查结果判断现有生产。
修改发现、下载、cookies 或媒体发布后，需要在对应 Linux 镜像与真实挂载中验证，
保持源 cookies、Badger、媒体路径和硬链接语义，不能只在 Mac 跑 Go 程序后宣布生产已修复。

## 生产运维约定

- 生产服务使用 Mac mini 的 Colima `platform` 与 Dockge；平台目录为 `/Users/chengkangyang/DockerPlatform/runtime`。
- 在 Mac 宿主上管理 Docker 时，命令统一通过 `/Users/chengkangyang/.local/bin/docker-platform docker ...`；不要默认使用其他 Docker context、创建第二台 VM 或重装一套生产服务。
- 生产问题先检查实际 Compose、容器状态/日志、挂载数据及业务接口。Mac 上的 `node`、Python、Homebrew 或开发测试结果不能替代 Linux 容器验收。
- 改动运行时代码后，按当前源码和锁文件构建对应镜像，更新原 Compose 并检查实际业务结果；不要仅修复宿主依赖后宣称生产已修复。
- 持久状态、业务日志和凭据放在内置盘的已登记目录或 Linux volumes；凭据不进入镜像、仓库或聊天输出。保留原身份、队列与未知结果，不重放来历不明的任务。
- 允许在 Mac 编辑、构建和运行开发测试；不要把这误当成恢复 Mac 原生生产服务。宿主 TUN、VM 网络模式和时钟不是项目故障的默认修改对象。

已在容器内时，直接使用该容器的 Linux Node/Python 与挂载状态执行应用检查；不要安装 macOS 工具、恢复宿主 LaunchAgent 或尝试在业务容器中启动第二套 Docker。

## 内置盘存储切换后的约定

核心 VM、镜像、Linux volumes、控制配置和恢复状态位于内置盘
`/Users/chengkangyang/DockerPlatform/runtime`。原 4T VM 保留为切换时冷备；新服务已产生写入，回退必须先排空并同步新状态，
不能直接启动旧 VM。Monga / Podsync 媒体仍在 4T，通过独立媒体门禁与恢复器
接入；不能恢复 USB VirtioFS 直挂。宿主入口仍统一使用 `docker-platform`，
业务频率、账号态、未知结果与任务账本沿用。

## 更新镜像与媒体恢复器登记

媒体恢复器绑定具体容器 ID 和配置指纹。直接 `docker compose up` 重建 producer
会使登记失效、撤销媒体租约；只改 Compose 镜像并不能完成部署，回滚镜像也一样。

- 部署前保存原 Compose、容器身份、源配置与 Cookie 哈希，以及
  `runtime/state/media-recovery/podsync/` 下的配置、激活记录和恢复状态。
- 受控排空媒体消费者并停止该服务的恢复器；在已验证的媒体传输与挂载可用时，
  仅创建新容器，不提前启动业务进程。停止传输前应正常卸载不再使用的 NFS 挂载，
  恢复只读占位挂载，避免下次启动检查阻塞在失联挂载上。
- 核实新镜像、门禁入口、挂载、只读凭据和唯一写入者，再更新容器登记及对应配置哈希。
  保留原重试记录和预算；已阻塞状态须先核实原因、保存证据，再完成登记交接。
- 由原恢复器重新验证介质身份、读写与硬链接并签发租约，启动消费者。
  不手工制造租约、不绕过门禁、不清空恢复状态。验收须包含恢复器 `ready`、
  实际二进制 commit、内部健康、远端事件、RSS 和媒体 Range，并复核源配置哈希。

只读 inspect 暂时不可用时，已准入会话可进入 `checking`，撤租后最多三次有限观察；
成功后须重新核验原消费者会话与介质 I/O，才恢复 `ready`。共享平台维护锁使租约过期时显示
`waiting`，解锁后也要重新验证。它们与需人工审查的 `blocked` 分开记录；
现有业务可能仍可用，但不能只看 phase 或进程存活，验收必须读到 Linux 有效租约与实际门禁通过。
复发条件、验证及历史证据见 [10 月 27 日记录](docs/incidents/2026-10-27-media-recovery-and-migration-dns.md)。

已准入会话的租约发布若获 guest 成功确认但超过两秒预算，也先撤租，最多三次有限重验；
重新核验原会话、制品、介质和 I/O 后才可恢复。SSH 超时等写入结果未知的情况仍阻塞，
十秒 TTL 和连接预算不变。边界与验收见 [10 月 28 日记录](docs/incidents/2026-10-28-acknowledged-lease-publication.md)。

10 月 28 日后续已采用 Podsync 独立 v2 门禁与固定 ID 的暖驻只读观察器，身份观察每轮实际检查 diskutil/介质路径。
inspect 由原 wrapper 每轮重新校验守卫，并新建 Unix 连接，仅 GET 已登记 ID。
租约必须有宿主对完整 guest 回执的 nonce 确认；十秒到期点在 guest 初始时钟读取时固定，
不得由迟到 writer 重新计算。实际门禁位于
`runtime/control/media-recovery-podsync-v2-20261028-boot-budget/media-gate`，最终控制器位于
`runtime/control/media-recovery-podsync-v2-api-final-20261028/`。不能与 v1 signer 混用，
也不能替换 Monga 的共享旧门禁。计时、边界、回退和生产验收见
[后续根因记录](docs/incidents/2026-10-28-recovery-control-plane-root-cause.md)。
