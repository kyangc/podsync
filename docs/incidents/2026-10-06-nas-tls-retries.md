# 2026-10-06 NAS 请求超时与 EOF

截至 2026-10-06 08:43（UTC+8）。生产仍运行 `ab5f138`，容器未重启。本记录不包含业务 ID、订阅地址或凭证。

## 已验证的原因与边界

Worker 控制面和 YouTube API 的失败发生在新连接的 TLS 握手阶段，尚未收到 HTTP 响应。NAS 对两个目标均解析到 fake-IP 地址段 `198.18.0.0/15`，DNS 及到透明代理的 TCP 连接通常只需几毫秒。握手则出现约 3 秒后的 EOF 或 10 秒超时。该证据定位到 NAS 出口代理链路上的新 TLS 连接；仍需网关出口日志才能确定具体代理节点或上游连接失败的原因。

只读 Go 探针使用生产容器的配置和凭证，响应只输出状态、阶段和耗时，未写入控制面数据。Python 探针收到的 403 未用作服务故障证据；真实 Go 请求成功取得配置和 YouTube API 响应。

| 验证场景 | Worker 配置 | YouTube API |
| --- | --- | --- |
| 第一轮新连接，各 30 次 | 1 次 TLS 超时、1 次握手 EOF | 1 次握手 EOF |
| 第一轮复用连接，各 30 次 | 30 次成功 | 30 次成功 |
| 使用本次重试实现的新连接，各 30 次 | 1 次真实握手 EOF 经重试恢复，最终 30 次成功且配置与 cache 一致 | 30 次成功 |

这是不同时间窗口的诊断样本，不用于推算生产错误率。第一轮探针用 Go 1.27.1；重试探针及项目检查用 Go 1.25.8。重试探针自身也捕获了握手 EOF，因此恢复结果不依赖两轮之间的版本或网络状态比较。

客户端的直接缺陷是单次网络失败即退出：配置/tombstone 要等下一次五分钟刷新，源站 discovery 要等下一次 feed 调度。故障注入在修改前复现了握手 EOF、配置响应截断、事件响应丢失和 YouTube API EOF；修改后全部通过。

## 修复

[统一重试逻辑](../../pkg/httpretry/retry.go)用于 [NAS API](../../services/remote/client.go)、[配置拉取](../../cmd/podsync/remote_config.go)和 [YouTube discovery](../../pkg/builder/youtube.go)。每次幂等操作最多尝试两次，间隔 250ms，共用 30 秒总预算，并尊重更短的调用方 deadline/cancellation。

只重试 EOF、响应截断、连接重置及网络超时。HTTP 状态错误、证书错误、配置/协议校验失败仍返回给原调用流程；持续瞬态故障仍保留终态错误，触发原告警、cache 回退或 durable outbox 保留。事件重发保持相同 payload、run ID 和 sequence，由 Worker 去重。Cookie、下载参数、媒体文件及数据库 schema 均未修改。

## 当前实际影响

- 两次配置回退均来自 cache；分别在 4 分 53 秒、5 分钟后重新拉取成功。当前远端配置和已接收 cache 一致，共 28 个 feed。
- NAS 最近成功应用的 tombstone 游标与 D1 最大游标一致，没有观察到未应用积压。
- 近 48 小时从 sequence=1 开始的 run 没有事件序号缺口；近 24 小时日志没有事件持久化失败告警。丢响应重放及 Worker 去重均有回归验证，未发现本次上传告警造成事件丢失的证据。
- 近 24 小时累计错误为 23；比 08:04 基线新增 3 次 YouTube discovery 失败和 1 次下载失败。3 个 feed 尚未观察到后续成功更新，下载也尚未验证恢复。
- NAS `/health` 当前返回 503，原因是 1 个近期下载失败；最近 feed 更新尚未超过六小时阈值，容器仍运行。当前 run 仍在预期的一小时窗口内，不能据此认定同步卡住。
- Worker 配置/tombstone 持续更新，最近成功时间分别为 08:38:56、08:38:58。网络波动仍可复现，不能宣称出口已恢复稳定。

## 验证

- `go fmt ./...`、`golangci-lint run`、`make test` 全部通过；lint 为 0 issues。
- `pkg/httpretry`、`services/remote`、`cmd/podsync`、`pkg/builder` 的 race 检查通过。
- Worker `events-batch.test.ts` 的 14 个测试通过，包括重复事件去重。
- Linux amd64、CGO disabled、`netgo` 的完整 Podsync 候选二进制构建成功。
- NAS 只读重试探针捕获真实 EOF 后取得完整配置；临时 NAS/容器探针已移除。

## 上线与回滚步骤

[AGENTS.md](../../AGENTS.md)要求未明确授权时不提交或推送。用户于 2026-10-06 09:09（UTC+8）授权提交、推送和 NAS 部署。推送 `main` 会自动触发现有 Nightly workflow，因此 Git 推送也会发布镜像。以下为实施和回滚步骤，实际接受结果以部署回执为准。

1. 审查本次 diff，提交并推送获准的修复，确认 CI 与 Nightly 镜像 smoke 检查成功，核对镜像内 commit。
2. 在 NAS 保存当前容器的精确 image ID，并标记为 `local/podsync:pre-network-retry-20261006`，防止旧镜像被清理。
3. 在现有 Compose 项目目录中同时使用 `compose.yaml` 和 `compose.media-origin.yml`，仅 pull/up `podsync`，通过 `--no-deps --timeout 30` 给进程优雅退出时间。NAS Compose 已验证支持这些选项。
4. 核对运行镜像/commit、配置 cache 更新、tombstone 追平、事件连续性、正常调度后的三个 feed 恢复及失败下载的后续交付。若产生媒体，验证公开 RSS、Range 响应和大小；构建或启动成功不替代这些接受条件。
5. 需要回滚时，使用只覆盖 `podsync.image` 的临时 Compose override，指向保存的本地旧镜像，配合 `--pull never --no-deps --timeout 30` 重建该服务。保留现有配置、DB 和媒体挂载，再执行同样的接受检查；本次没有数据迁移。

客户端修复能够恢复部分瞬态请求，不能修复代理节点本身。具体出口节点的诊断仍待网关管理入口及故障时段日志。
