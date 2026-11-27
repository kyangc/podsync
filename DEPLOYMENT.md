# 运行与部署约定 · 2026-11-27

## 当前生产拓扑与路径

- **生产运行环境**：Mac mini Colima `platform` VM 与 Dockge，平台根目录为 `/Users/chengkangyang/DockerPlatform/runtime`（物理目录 `/Volumes/4T/PersonalCloud/runtime`，仅通过该登记软链接使用）。
- **Podsync Stack 目录**：`/Users/chengkangyang/DockerPlatform/runtime/stacks/podsync`
- **应用状态与临时目录**：位于 Linux volumes（`podsync-db` 内 `/app/db/` 含 BadgerDB 与 `/app/db/diagnostics/`；`podsync-tmp`）。
- **媒体存储与发布路径**：`/Volumes/4T/PersonalCloud/PublishedMedia/podsync`（4T 外置卷 UUID `3ED22C2E-B087-46D6-8A61-494A45741576`），继续通过原 NFS 门禁暴露到 guest `/mnt/platform-media/podsync`，不新增媒体 VirtioFS 直挂。
- **可替换租约存储**：位于 Linux VM ext4 本地卷 `podsync-media-lease`（`/var/lib/docker/volumes/podsync-media-lease/_data/lease.json`），两个消费者在 `/run/platform-media-lease` 只读挂载；宿主不可变 ACK 目录 `/Users/chengkangyang/DockerPlatform/runtime/state/media-recovery/podsync/lease` 只读绑定到 `/run/platform-media-host-ack`。
- **公网入口与域名**：用户订阅与控制面域名为 `https://podsync.kyangc.net`，媒体源站为 `https://media.podsync.kyangc.net`；旧 NAS 容器和 `router.kyangc.com:9092` 已停止。
- **实际发布与冻结制品清单**：以平台 `deploy/mac-platform/current-release.json` 中 `stacks.podsync` 及恢复器 `config.json` 为准（当前已启用 `media-gate` v2、`lease_stream`、`probe_stream`、`inspect_prefix` 与 `drain_history_archive`）。

## 生产运维硬性约定

1. **Docker 命令入口**：在 Mac 宿主上统一通过 `/Users/chengkangyang/.local/bin/docker-platform docker ...` 管理容器；禁止切换 Docker context、创建第二台 VM 或重装第二套生产服务。
2. **容器验收准则**：Mac 上的 Go/Node/Python 测试不能替代 Linux 容器验收。改动应用或控制面后，必须按当前源码构建对应 Linux `arm64` 镜像或冻结制品，在真实挂载中完成验收。
3. **凭据与队列边界**：持久状态、业务日志与凭据仅存放在 PersonalCloud 已登记目录或 Linux volumes；不得进入镜像、Git 仓库或聊天输出。不得修改或污染源 `bilibili-cookies.txt`、历史失败记录或未知写入结果，不重放来历不明的任务。
4. **宿主环境隔离**：宿主 TUN、VM 网络模式和系统时钟不是默认修改对象；不要在运行中的解释器依赖被移除后只改路径强行启动。媒体错误响应必须 `no-store`。
5. **双消费者门禁约束**：`podsync`（writer）与 `podsync-media-1`（reader）的 Docker 健康检查均先执行实际 v2 `/platform-media-gate`（`podsync` 随后探测内部 `/health`，`podsync-media-1` 探测 `/healthz`）。应用内部健康或公网响应不能替代门禁、有效 Linux 租约与宿主 ACK 验证。

## 媒体恢复器、更新镜像与重启 SOP

媒体恢复器绑定具体容器 ID、配置指纹与 `config_sha256`；直接执行 `docker compose up` 重建容器会使登记失效并撤销租约。升级镜像、变更挂载或计划重启宿主前必须遵循以下流程：

1. **核对并发维护与留存前置快照**
   - 确认无冲突维护操作（必要时协调共享 `runtime.lock`），确认源 `compose.yaml`、`config.toml`、`bilibili-cookies.txt`、`config.json`、`activation.json` 及历史探针残留哈希/mtime，并将原配置文件与 `state.json` 保存到受限 `runtime/private/...` 目录（目录 `0700`、文件 `0600`）。
   - 检查容器实时日志，确认无正在进行的下载/转码任务。
2. **受控排空与近 24 小时日志归档**
   - 仅向已登记容器发送 `TERM` 排空，等待全部消费者退出 `0` 且 `OOMKilled=false`；遇到 `Exit255`、非零退出或缺失正常退出日志时，立即停止并先保全日志与停机库，核对 outbox 与 D1 后再审查交接，不得只清除 `blocked`。
   - 重建或移除旧容器前，按原容器 ID 归档截至正常 drain 完成的近 24 小时 `docker logs --timestamps` stdout/stderr，读回校验时间范围、退出尾部、字节大小与 SHA-256（若容器寿命或保留范围不足 24 小时，明确记录覆盖起点与缺口）。
3. **安全卸载 NFS 与停止恢复器**
   - 在旧传输进程退出前正常卸载 `/mnt/platform-media/podsync` 上的 NFS 挂载，确认恢复只读 `platform-media-offline` tmpfs 占位，防止失联 `hard` NFS 挂死后续启动检查；同 UUID 盘短暂失联后若旧 NFS 根句柄已被撤销，同样必须走完整卸载并替换传输的流程。
   - 通过 `launchctl bootout` 停止 `com.local.docker-media-podsync`，确认恢复器、`transport`、`unfsd`、SSH 隧道均已退出且 `owner.lock` 可非阻塞获取。
4. **受控重建（不启动）与重新登记**
   - 若需更新镜像或挂载，先用临时传输与挂载执行 `docker compose create --no-start <service>`，随即正常卸载并停掉临时传输；严禁提前启动业务进程或手工制造租约。
   - 核实新容器 ID/配置指纹、`config.json` 制品哈希与 `activation.json` 摘要，在同时持有 `runtime.lock` 与 `owner.lock` 下追加 clean drain 记录与 `maintenance_handoffs` / `reviewed_blocks` 交接记录（保留全部历史、预算与未知结果），将 `phase` 设为 `offline` 后原子写回 `state.json`。
5. **重新准入与完整验收**
   - 更新并 `launchctl bootstrap` 启动 `com.local.docker-media-podsync`，由原恢复器完整验证卷身份、NFS 挂载、介质 I/O、双时钟 10 秒租约与完整 nonce ACK 后拉起消费者。
   - 验收必须覆盖：恢复器 `phase=ready`、双容器 `running (healthy)` 与 `RestartCount=0`、实际 `/platform-media-gate` 返回 `0`、Linux 租约与宿主 ACK 一致、实际二进制/应用健康、D1 事件连续无新增错误、媒体 RSS `200` 与 `Range 206` 前缀校验及硬链接一致，以及源配置/Cookies 哈希不变。

## 控制面机制与历史演进摘要

- **2026-10-25–10-31**：从 NAS 迁入 Mac mini Colima `platform` VM；引入独立 v2 `media-gate`（双时钟 10 秒 TTL、2 秒发布预算、完整 nonce ACK）、Darwin 内核卷属性观察、`lease_stream` 常驻发布器、有限观察重试（`checking` / `waiting` 与永久 `blocked` 隔离）、有界调用诊断以及安全停机排空。
- **2026-11-01–11-13**：补全有界诊断 guest 阶段与 poll gap 留证；完成个人云存储目录冷迁（`/Volumes/4T/PersonalCloud/runtime`）、启用内置盘 4 GiB swap、完成依赖恢复与宿主重启后播放验收。
- **2026-11-22–11-27**：上线 `probe_preflight` 与 Linux ext4 原生租约存储消除 VirtioFS 并发替换 `ENOENT`；随后优化为常驻暖 `probe_stream`（防止高频冷 SSH `[preauth]` 触发误阻塞）、停机前主动卸载 NFS、`drain_history_archive` 与外置大历史归档瘦身 `state.json`。

完整分日事故复盘、证据边界与恢复记录见 [事件与复核总索引](docs/incidents/README.md)（重点参考：[v2 门禁根因](docs/incidents/2026-10-28-recovery-control-plane-root-cause.md)、[有界诊断](docs/incidents/2026-10-31-bounded-diagnostics.md)、[宿主重启恢复](docs/incidents/2026-11-13-reboot-playback-recovery.md)、[探针预算与原生租约](docs/incidents/2026-11-22-probe-write-budget-and-download-review.md)）。
