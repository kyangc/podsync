# 2026-10-07 YouTube 下载波动与读取超时重试

生产统计快照截至 2026-10-07 09:30，北京时间（UTC+8）；本地验证随后完成。NAS 仍运行 `921867c`，本次补丁仅在本地。本文用 A/B/C 代替节目身份，不包含业务 ID、订阅地址或凭据。

## 结论

三个最终下载失败均已通过原版本的正常调度交付。两个 `Requested format is not available` 失败的前置原因是播放器 API/JavaScript 的传输失败，不能据此认定格式选择器配置错误。另一集已经选到带音频的 format 18，下载到约 53% 后读取超时。

已证实一处下载管理器缺口：yt-dlp 的媒体读取超时耗尽内部重试后，若输出没有 TLS 握手/EOF 字样，Podsync 不执行既有的外层重试，直接记录最终失败。本地补丁仅补足这个具体错误模式，保留格式选择、鉴权、重试上限与持续失败告警。

NAS 的透明代理出口仍有波动：本次只读提取探针也捕获 EOF/读取超时后恢复。现有证据不能确定具体代理节点，也不能将故障唯一归因于代理节点、代理上游连接或 YouTube 边缘服务；需要同时间的网关出口日志。

## 当前交付与运行证据

以 D1 的 feed/episode 身份关联失败、下载完成和发布确认；关联得到的源资源身份一致。

| 节目 | 最终失败 | 后续下载完成 | 后续发布确认 | 当前状态 |
| --- | --- | --- | --- | --- |
| A | 10-06 20:21:16，媒体读取超时 | 10-06 21:45:51 | 10-06 21:48:25 | visible |
| B | 10-06 21:24:09，格式不可用 | 10-06 22:20:29 | 10-06 22:23:24 | visible |
| C | 10-06 21:38:39，格式不可用 | 10-06 22:24:35 | 10-06 22:28:24 | visible |

- 部署以来仍只有 3 次最终下载失败，涉及 3 集；最后一次为 10-06 21:38:39。没有这些失败集未交付的证据。
- 10-07 09:26 重新核验三集：公开 RSS 200 且包含对应节目；enclosure 大小/MIME 与 D1 一致；媒体 HEAD 200、大小/MIME 一致；Range 206，返回 1024 字节，总长度与 D1 一致。此检查没有逐字节校验完整媒体。
- 09:30 最近完成的一轮同步为 success，07:39:23–08:40:23，feed/下载/上传为 28/2/2，errors_count=0。当前轮于 08:40:23 开始，28/1/1、errors_count=0，仍在正常的一小时窗口内。
- NAS `/health` 为 200/healthy；Podsync 和 PO Token sidecar 均运行、RestartCount=0。Worker `/health` 为 200；未认证 dashboard 请求仍 302 跳转 Cloudflare Access。
- 最近 24 小时同步错误累计为 5；另有 1 次 feed 更新失败和 2 次 tombstone 告警，不能与下载格式错误合并归因。窗口推进会改变这个累计数，本地补丁尚未上线，不能将下降归功于补丁。

## 失败链条

NAS 部署后的 7 条格式错误是尝试级日志，分为：

- 2 条：mweb player API JSON 在内部重试后仍因握手超时/EOF 获取失败，随后只剩图片格式。
- 5 条：播放器 JavaScript 下载因 TLS 握手超时失败，n challenge 求解失败，随后只剩图片格式。报错明确是无法加载播放器脚本，并非 Deno 不存在或求解器未安装。

这 7 条包括 B 的 3 次尝试、C 的 2 次格式失败尝试、A 在后续恢复期间的 1 次格式失败尝试，以及另一集在外层重试后恢复的 1 次尝试。它们不能算作 7 个最终失败事件。

A 在 20:21 的完整 NAS 输出显示：播放器和 PO Token 步骤完成，Deno 已求解 challenge，选到 format 18；媒体下载在约 53% 后出现读取超时，yt-dlp 重试一次仍失败，最终输出为：

```text
ERROR: [download] Got error: The read operation timed out. Giving up after 1 retries
```

该次输出没有 TLS 握手或 EOF 字样，随后也没有 Podsync 外层重试告警。C 的首个失败尝试同样已经选到 format 18 后发生读取超时，但输出同时包含先前 TLS/EOF，因而被现有分类器识别并重试。

D1 的 error_detail 上限为 2048 字符；A 的进度输出占满了记录，终态读取超时文字未被保留。因此本次使用完整 NAS 输出判断阶段和原因，没有仅凭 D1 的截断文案归因，也没有修改事件计数或截断策略。

## 格式、鉴权与请求条件

当前 13 个 YouTube feed 均使用 mweb 与 progressive HTTPS 选择器：

```text
18/best[protocol=https][vcodec!=none][acodec!=none]
```

远端参数追加在默认音频参数之后，实际覆盖默认的 `bestaudio`；仍按音频 feed 转成 MP3。socket timeout 为 12 秒，yt-dlp 媒体/fragment retries 均为 1；extractor 自身日志中的 3 次重试属于另一层。

本次针对 A/B/C 做了各一次只读提取，沿用生产参数和网络，禁止媒体下载并关闭 yt-dlp 磁盘 cache，不传入 Cookie：

| 节目 | player playability | 上游音频流数 | 最终选择 | 播放器 JS/求解器 |
| --- | --- | --- | --- | --- |
| A | OK | 12 | 18，含音频 | 成功 |
| B | OK | 12 | 18，含音频 | 成功 |
| C | OK | 18 | 18，含音频 | 成功 |

- A 的探针仍经历 EOF/读取超时，约 145 秒后成功；B/C 各约 5 秒完成。日志关键字计数不代表独立网络故障次数。
- 三次均加载 `bgutil:http-1.3.1`、生成 gvs PO Token、用 Deno 求解；没有 Bot Check、登录拒绝、HTTP 403 或 provider 失败。sidecar 为匹配的 1.3.1，healthy，日志驱动仍为 none；没有读取或启用会输出 Token 的 provider 日志。
- yt-dlp 为 `2026.08.19`，Deno 为 2.7.4，EJS 为 0.8.0。启动及每日 self-update 输出仍为同一 yt-dlp 版本，没有观察到升级带来的恢复。官方 zipimport 发行包包含 EJS，见 [EJS 安装说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。
- 这三个 YouTube feed 不使用 Cookie profile；当前没有 YouTube 登录会话或源 Cookie 被轮换的证据。1 份源 Bilibili Cookie 在诊断前后的 SHA-256 一致。
- 容器未设置显式 proxy 环境变量，yt-dlp Proxy map 为空，但 YouTube/Worker 域名解析仍落在 `198.18.0.0/15` fake-IP 段。空 Proxy map 不能证明绕过了透明代理。

当前选择器确实可以为同一资源取得含音频的 format 18，且相关 feed 的 D1 配置更新时间早于此次故障。这排除了当前持续格式配置缺陷的证据，但不能证明历史成功下载必然选择了相同 format ID：成功时的 yt-dlp 输出没有被保留，失败时也没有保存原始 player JSON、成功请求条件、Token/session 或实际出口节点。因此无法完整还原失败到成功之间的播放器版本、格式列表或出口条件变化。PO Token 的存在本身也不保证所有请求成功，见 [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)。

## 重试行为与本地修复

`921867c` 修改的是 NAS 控制面和 YouTube discovery 的小型幂等 HTTP 请求：最多两次尝试、间隔 250ms、共用 30 秒预算。它没有修改 [yt-dlp 封装](../../pkg/ytdl/ytdl.go) 或 [下载管理器](../../services/update/updater.go)。不能用该 HTTP 重试预算解释整个媒体下载。

媒体下载原有的外层规则为：YouTube HTTP 403、TLS 握手超时或 EOF 最多尝试 3 次，退避 5 秒和 30 秒，每次启动新的 yt-dlp 下载。B/C 的日志显示 next_attempt=2/3 和 tls_transport；最终失败在尝试耗尽后才写入 D1，分类行为符合现有代码。当前配置的每次 yt-dlp 进程上限为 30 分钟；此次补丁没有延长预算或增加次数。

补丁只为 yt-dlp 明确输出“媒体读取超时，已耗尽内部重试”的情况返回 read_timeout，复用原外层规则。只匹配终态媒体错误，避免仅凭前面的读取超时 warning 重试最终的格式/登录错误。单独的格式不可用仍终止，持续读取超时仍保留一次最终失败及原始错误；非 YouTube provider 不改变行为。

## 本地验证与上线边界

- 回归测试在修改前复现了缺口：预期第二次下载成功，实际只调用一次并记录失败；补丁后通过。
- 覆盖恢复、三次耗尽后只记录一次失败、非 YouTube 不重试，以及纯格式缺失/登录错误/非终态读取超时 warning 不扩大重试范围。
- 将相关三集的 8 段原始失败输出脱敏后，在下载管理器原调用流程中做差分回放：部署版本只有 A 的 20:21 媒体读取超时未执行外层重试；候选补丁 8/8 通过。在模拟随后下载成功、存储和事件写入的场景中，没有提前记录最终失败。它验证的是本地重试行为，不是重新执行生产下载。
- `go fmt ./...`、`golangci-lint run`（0 issues）、`make test` 全部通过；下载相关 race 检查通过。使用 Go 1.25.8；Linux amd64、CGO disabled、netgo 候选二进制构建成功。
- 检查使用 [下载回归测试](../../services/update/updater_test.go)，变更保留原 module path。未改变格式、Cookie/Token、出口、Worker 配置、错误计数或保护策略。

未提交、推送、部署、重启、重跑生产同步或补数据，也未执行媒体清理/迁移。本地测试及既有节目公开交付验证，不能替代补丁的生产接受检查。

用户于 2026-10-07 10:30 授权提交、推送和 NAS 部署。以上为授权前诊断快照；实际生产接受结果以部署回执为准。

上线仅发布本次补丁并更新 Podsync，核验运行 commit、健康、源 Cookie，以及正常调度后的完整下载/转码/发布/RSS 与媒体 Range。继续保留持续失败告警；不应为了验收手工重跑已交付三集。若要定位网络根因，还需要故障时间对应的网关规则命中、实际出口节点和上游连接日志；在取得这些证据前，不建议盲目改格式、轮换凭据或更换代理配置。
