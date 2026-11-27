# Podsync 生产事件与复核索引

按时间倒序列出 2026 年 10 月至 11 月生产巡检、控制面修复与故障复核记录。所有时间均以各文档正文标注为准。

## 2026 年 11 月

| 日期 | 记录 | 摘要 |
| --- | --- | --- |
| 2026-11-22 | [探针写前预算、原生租约存储与下载复核](2026-11-22-probe-write-budget-and-download-review.md) | 启用 `probe_preflight` 与 Linux ext4 原生租约指针，复核七个下载告警样本与双侧交付 |
| 2026-11-21 | [YouTube 格式、媒体期限与配置 EOF 分项复核](2026-11-21-youtube-format-media-deadline-and-config-eof.md) | 复核 YouTube 格式不可用、媒体下载超时与配置请求 EOF |
| 2026-11-20 | [YouTube bot 拒绝、媒体期限与 403 分项复核](2026-11-20-youtube-bot-rejections-and-media-timeout.md) | 区分 YouTube bot 校验、403 与媒体期限错误边界 |
| 2026-11-19 | [下载器更新限流与 metadata EOF 复核](2026-11-19-recovered-updater-rate-limit-and-metadata-eof.md) | 复核自更新限流与远端 feed metadata EOF 的自然恢复 |
| 2026-11-18 | [终态下载失败、事件 EOF 与墓碑超时复核](2026-11-18-recovered-download-event-and-tombstone-alerts.md) | 跨部署对账终态下载失败、事件 EOF 与墓碑超时 |
| 2026-11-17 | [事件 EOF、下载重试与原持久确认复核](2026-11-17-recovered-event-eof-and-download-alerts.md) | 核对空事件批末轮 EOF 与下载重试后的持久状态 |
| 2026-11-16 | [发现 EOF、下载重试和墓碑内部告警复核](2026-11-16-recovered-discovery-download-and-tombstone-alerts.md) | 复核 discovery EOF、下载重试与墓碑轮询内部告警 |
| 2026-11-15 | [发现、下载和远端同步新增告警复核](2026-11-15-recovered-sync-and-download-alerts.md) | 核对四次上传失败、五次墓碑失败与真实变更账本 |
| 2026-11-14 | [远端事件最终 EOF 与持久队列自然恢复复核](2026-11-14-recovered-remote-event-upload.md) | 核对持久事件队列在下一轮自然 Flush 后的恢复边界 |
| 2026-11-13 | [宿主重启后的播放恢复](2026-11-13-reboot-playback-recovery.md) | 宿主重启后保全原 ID 日志与停机库并按门禁完成播放验收 |
| 2026-11-13 | [磁盘压力停机后的 PersonalCloud 重新准入](2026-11-13-personalcloud-media-readmission.md) | 磁盘压力停机后验证 PersonalCloud 介质与重新准入 |
| 2026-11-12 | [下载器更新限流与远端内部 EOF 复核](2026-11-12-recovered-update-and-remote-eof.md) | 复核自更新限流与远端内部 EOF |
| 2026-11-11 | [远端事件、配置与 tombstone 内部 EOF 复核](2026-11-11-recovered-remote-eof.md) | 复核远端控制面三类内部 EOF 告警 |
| 2026-11-10 | [远端配置内部 EOF 自然恢复复核](2026-11-10-recovered-remote-config-eof.md) | 复核远端配置拉取瞬时 EOF 后恢复 |
| 2026-11-09 | [Bilibili API 告警自然恢复复核](2026-11-09-recovered-bilibili-api-alert.md) | 复核 Bilibili API 瞬时告警 |
| 2026-11-08 | [宿主解释器缺失与保护性停机](2026-11-08-host-dependency-recovery.md) | Python/OpenSSL 依赖变更后的保护性停机与重新登记恢复 |
| 2026-11-07 | [Bilibili API 与两轮 YouTube 格式告警自然恢复](2026-11-07-recovered-bilibili-and-youtube-format-alerts.md) | 复核 Bilibili 与 YouTube 格式瞬态告警 |
| 2026-11-06 | [同一 YouTube 节目四轮格式不可用，随后自然发布](2026-11-06-recovered-youtube-format-unavailable.md) | 复核连续格式不可用延迟交付及自然发布 |
| 2026-11-05 | [已恢复的 YouTube TLS 下载与 Bilibili API 告警复核](2026-11-05-recovered-youtube-tls-and-bilibili-api.md) | 复核 YouTube TLS 重试与 Bilibili API 告警 |
| 2026-11-04 | [guest 租约发布 I/O 停顿、审查恢复与取证补全](2026-11-04-guest-lease-io-stall.md) | 补全 16 个租约细分阶段与 8 次成功上下文留证 |
| 2026-11-03 | [已恢复的 YouTube discovery 超时与远端 EOF 复核](2026-11-03-recovered-discovery-and-remote-eof.md) | 区分 YouTube discovery 超时与 metadata EOF 边界 |
| 2026-11-02 | [平台重启后异常 writer 结局的审查恢复](2026-11-02-writer-exit-after-platform-reboot.md) | 处理重启后 Exit255、只读复核 BadgerDB 与重入 |
| 2026-11-01 | [未知租约发布超时的审查恢复与留证修复](2026-11-01-unknown-lease-publication.md) | 修复有界诊断过滤器丢失 guest 阶段与 poll gap 的缺口 |

## 2026 年 10 月

| 日期 | 记录 | 摘要 |
| --- | --- | --- |
| 2026-10-31 | [已恢复的下载失败与远端调用超时](2026-10-31-recovered-download-and-control-timeouts.md) | 区分发布调用计数、下载与实际交付验证 |
| 2026-10-31 | [维护卸载后同盘重连的恢复缺口](2026-10-31-planned-usb-reconnect.md) | 区分真正缺盘与观察未知，持久化 TERM 意图与安全重挂载 |
| 2026-10-31 | [新增固定 ID 观察超时的补充复核](2026-10-31-inspection-observer-timeout.md) | 补充复核固定 ID 观察超时 |
| 2026-10-31 | [修复取证轮转缺口并接入有界调用诊断](2026-10-31-bounded-diagnostics.md) | 接入宿主与容器侧有界调用诊断 |
| 2026-10-30 | [未知媒体探针、内存压力及完整重新准入](2026-10-30-probe-timeout-and-memory-pressure.md) | 审查全局 OOM 窗口探针超时，启用 swap 与 `lease_stream` |
| 2026-10-29 | [身份观察复发、真实 USB 失盘及媒体负缓存](2026-10-29-identity-usb-and-negative-cache.md) | 改用 Darwin 内核卷属性，处理 revoked 根句柄与 `no-store` |
| 2026-10-28 | [恢复器控制面根因与 v2 准入](2026-10-28-recovery-control-plane-root-cause.md) | 启用独立 v2 门禁、双时钟 10 秒 TTL 与暖驻只读观察器 |
| 2026-10-28 | [媒体租约慢发布后的永久阻塞](2026-10-28-acknowledged-lease-publication.md) | 已确认但超 2 秒预算的租约发布改走有限重验 |
| 2026-10-27 | [媒体恢复器、迁移 DNS 与下载重试复核](2026-10-27-media-recovery-and-migration-dns.md) | 初版媒体恢复器、域名迁移与下载重试边界复核 |
| 2026-10-26 | [生产中断、恢复与巡检证据边界](2026-10-26-storage-interruption-recovery.md) | 存储中断恢复与证据保全边界 |
| 2026-10-25 | [巡检入口失配、格式失败与进程中断复核](2026-10-25-production-inspection-runtime.md) | Mac mini Docker 生产运行确立及巡检入口对齐 |
| 2026-10-24 | [远端超时与 Bilibili 不可用节目复核](2026-10-24-remote-timeouts-bilibili-unavailable.md) | 复核远端超时与 Bilibili `-404` 跳过 |
| 2026-10-23 | [远端请求瞬时超时复核](2026-10-23-remote-request-timeouts.md) | 复核远端请求瞬时超时 |
| 2026-10-22 | [YouTube 直播回放格式暂时不可用](2026-10-22-youtube-post-live-format.md) | 复核直播刚结束时格式暂不可用 |
| 2026-10-21 | [媒体 Tunnel 响应阻塞与缓解](2026-10-21-media-tunnel-response-stall.md) | 复核媒体 Tunnel 响应阻塞 |
| 2026-10-19 | [媒体 Tunnel 握手故障](2026-10-19-media-tunnel-connectivity.md) | 复核媒体 Tunnel 连通性故障 |
| 2026-10-08 | [YouTube 播放器 API 传输失败与正常调度恢复](2026-10-08-youtube-player-api-transport.md) | 复核 YouTube 播放器 API 传输失败 |
| 2026-10-07 | [YouTube 下载波动与读取超时重试](2026-10-07-youtube-download-transients.md) | 复核 YouTube 下载读取超时重试 |
| 2026-10-06 | [NAS 请求超时与 EOF](2026-10-06-nas-tls-retries.md) | 复核 NAS TLS 重试与 EOF |
