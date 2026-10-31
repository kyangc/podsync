# 2026-10-31：修复取证轮转缺口并接入有界调用诊断

本轮解决的是已证实的诊断缺口：固定 ID 观察超时的阶段记录在日巡前轮转，
Go 远端请求仅保留最终超时，无法区分连接排队、DNS、连接、TLS、首字节和响应读取。
[原观察事件](2026-10-31-inspection-observer-timeout.md)与
[原下载和 HTTP 事件](2026-10-31-recovered-download-and-control-timeouts.md)的底层原因仍未确定。
新诊断和绿色验收均不能作为根因已彻底修复的证据。

## Go 自然调用

`pkg/diagnostics` 使用标准 `httptrace`，接在既有 config、event、episode、metadata、
tombstone 以及 Bilibili discovery 调用的原 context 上。没有替换 Transport、代理、
HTTP/2、连接复用、重试或超时。回执涵盖响应 body 读取、JSON Decode 和原 Close；
原返回值/错误不变，Close 或读取的额外诊断错误不改写业务结果。

记录包括请求起止 epoch ns、原 context/client 预算、连接取得/首次网络阶段前排队、
DNS、连接、TLS、写请求、首字节、body/Decode/Close 耗时，以及状态码、连接复用、
request-written、headers、EOF、Close failure 和类型化错误类别。
连接取得时间包含网络阶段；不能将它与各子阶段简单相加。
并行拨号采用有界 inflight 和重叠区间计时，多次连接取得也标记 `trace_ambiguous`；
阶段是最后观察点，特别在并行/重定向时不能冒称唯一阻塞原因。
回调并发受锁保护，Finish 后的迟到回调不再修改快照或重复提交。
失败记录不判断原请求是否已被服务端接收，原 outbox/未知结果规则不变。

下载复用原 yt-dlp 输出捕获和摘要，增加 Bilibili extract/media/postprocess 首次偏移、
无数据块的固定布尔标记及不含节目 ID 的有界留证。discovery 另记录数字 API code。
没有追加下载、扩大重试、采集原始 HTTP 头/body 或改变源 Cookie 的临时副本行为。
yt-dlp 子进程内部的 DNS/TLS/传输分段仍不可见，不能用 Go 的 discovery 证据替代它。

## 存储、保留和故障隔离

应用启动在 `database.dir/diagnostics` 打开一个 worker 和 64 条记录的非阻塞队列。
生产对应 `podsync-db` 内 `/app/db/diagnostics`，不写外置媒体。
成功每个固定 operation 每小时最多一条；失败尽力接收，过载可丢弃并累计 dropped。
worker 的写入错误累计 write_failures，Linux 内存/PSI 快照也只在 worker 上读取，
有独立资源采样时间，不冒充请求发生时的历史资源值。没有额外网络探测或高频 fsync。
退出最多等待 200ms；诊断慢盘不成为请求或业务 cleanup 的同步依赖。

| 范围 | 文件上限 | 单文件上限 | 单条上限 |
| --- | --- | --- | --- |
| Go failure | 8 段，总计最多 8 MiB / 8,192 条 | 1 MiB 或 1,024 条 | 2 KiB |
| Go baseline | 2 段，总计最多 2 MiB / 2,048 条 | 1 MiB 或 1,024 条 | 2 KiB |
| Podsync 恢复器 failure | 8 段，总计最多 4 MiB / 4,096 条 | 512 KiB 或 512 条 | 8 KiB |
| Podsync 恢复器 baseline/状态转换 | 2 段，总计最多 1 MiB / 1,024 条 | 512 KiB 或 512 条 | 8 KiB |

另在 UTC 日界切段。每次写入按段首记录的七天年龄清理，独立于文件 mtime；
新日记录不混进即将过期的旧日段。容量未触发时，failure 可跨日巡保留六至七天；
容量/条数/段数先到则淘汰最旧诊断。baseline 受两段上限约束，按日切段也可能先淘汰。
闲置或进程停止期间不跑清理任务，下一次写入再执行年龄检查。
诊断目录 0700、文件 0600，拒绝跟随段文件符号链接；仅操作自己固定名字的诊断段。
内容严格限定枚举、数字和布尔值，无完整 URL/query、头/body、错误原文、Cookie、
Authorization/Token、feed/episode/run/generation/nonce 或地址。

## 宿主观察、共享锁和写入边界

平台 `bounded_diagnostics=true` 仅为 Podsync 登记。复用既有观察/身份/SSH 进度，
异常与稀疏成功基线独立写入 `state/media-recovery/podsync/diagnostics`，不再依赖几十分钟的轮转。
原 `timing*.jsonl`、`probe-failures.jsonl` 和其他历史文件保留；开启新模式后不再追加旧文件。
诊断仅在线程上做文件 I/O、Data 卷 free bytes 和宿主 load/rusage 采样，不在撤租临界路径同步写入。
记录资源采集时间，队列 64 条、失败计数/丢弃计数和关闭等待 200ms 均有界。

Podsync 通过显式 `inspect-stream-diagnostics` 只读入口启用 guard、Unix connect、request-written、headers、body、decode
阶段；旧 `inspect-stream` 默认保持原协议，旧控制器无需升级。新入口仅增加
固定阶段及数字 index。管理 Docker 仍使用统一 `docker-platform`；细进度观察制品定点登记，
不替换其他服务正在使用的全局 wrapper。合法进度持续消费、只保留尾 32，独立留证带尾部窗口
和最后阶段，未知 kind/stage 仍拒绝；两次固定 ID GET 的范围、三秒观察和 2.5 秒 API 预算不变。
共享锁等待作为状态转换独立保留，不能混算为观察超时。
SSH 写探针或发布结果未知仍撤租/阻塞；即使 guest 进度完成也不授权重放或签租。
原 nonce 全字段 ACK、wall/BOOTTIME/boot ID 十秒 TTL、两秒发布/门禁及连接预算保持。

## 验证与运行读回

确定性回归覆盖 Decode/读取/Close 失败、迟到及重叠回调、阻塞/失败 sink、队列溢出、
容量/权限/符号链接、文件 mtime 刷新和跨七天低频记录保留；下载无数据块信号经分块、
输出截断后仍可见且不扩重试。平台夹具在 socket、headers、body、decode 阶段分别停住，
验证失败前阶段可持久保留；超过进度上限后最终 inspection 仍可接收。
guest 完成后 SSH 仍未知的夹具继续阻塞、保留预算、不重放；慢 sink 不妨碍撤租和 cleanup。

运行制品、定点交接和自然调用验收回执另记于本轮受限目录，未经实际读回不视为部署完成：
`/Users/chengkangyang/DockerPlatform/runtime/private/podsync-bounded-diagnostics-20261031/`。

## 实际部署和受控交接

本轮已部署，应用源码 `9efb50861ffb654e33dbf6a310a7a55fcaa4010a`，
平台控制器/helper 源码 `f591deac1a5d6efe75024b29a17b0f6b56cb0208`。
Linux arm64、Go 1.25.8、CGO 关闭；实际二进制 SHA-256 为
`33a5ccfbf65823c21cac87592687d230ed8b835cbbc9c82ac639f7917f9c7d2d`，
source manifest SHA-256 为
`efb85bfb505d0dc8a0fff0692a68a9315ddc5d841b5c4f5451768238993539de`。
镜像 index 为 `sha256:31ac87475fe44f13622807dc0643d2d25c9ae11eb17f3b302770d26061db9218`，
linux/arm64 manifest 为 `sha256:1d615149cb63959ed0789cd001bfa1f917da0f570909efa9bca1064883ad8011`。
旧实例的下载器因原有 self-update 已不同于基础镜像，构建时保留实际下载器和 ffmpeg
的原字节并在惰性容器中核对哈希；未改变 self-update 策略。

以下时间均为北京时间。15:11:27 确认没有活动下载/转换后，按原流程排空，
两消费者退出 0、正常卸载 NFS；保存停止状态的约 339 MiB DB 副本，未打开第二个 Badger writer。
15:19:17 登记并启动新控制器，15:19:20 两消费者由完整重新准入启动。
本次交接中断约 7 分 53 秒，不能声称无中断。

两次部署断言失败均保留，证明具体差异后才继续：

- 第一处 HostConfig 差异仅为 `OomKillDisable` 的 null/false 规范化及 Mounts 数组顺序；
  按目标排序并只规范该布尔字段后全部相同，实际挂载也相同。
  `--no-deps` 另改变 Compose dependency label，已使用本机支持的默认依赖创建流程恢复该标签；
  provider 原 ID、StartedAt 未变，未启动临时业务写入者。
- 第二处 image label 对比将 OCI index 与 Compose 记录的 arm64 子 manifest 混比；
  通过本机 `image inspect --platform linux/arm64` 证明对应关系，实际 container.Image、
  二进制、source manifest 和 OCI revision 均匹配。没有泛化忽略其他字段。

新控制器和 opt-in helper 位于
`runtime/control/media-recovery-podsync-diagnostics-20261031/`，严格取自上述平台提交，
未混入并发 Monga 工作区的改动。全局 CLI 和 Monga 登记的该文件哈希保持。
15:24 的交接后核验确认 Monga 未被本轮重启；它随后由自己的修复线程于 15:28 独立部署，
故不能在更晚的验收中继续声称它的启动时间从未变化。
原 Podsync 媒体容器 ID、v2 门禁、源配置/Cookie 哈希与 mtime/只读绑定、
历史事故、人工审查及预算全部保留。仅 producer 重建；Tunnel/provider 未重启，整机/VM 未重启。
实际发布与恢复登记摘要已同步平台 `current-release.json` 的 Podsync 子树，保全其他项目改动。

## 自然调用和媒体验收

15:38:47–48 最终运行读回：恢复器 ready、observation_streak 0、事故历史仍 52；
两个实际 gate 通过、消费者 healthy、RestartCount 0。完整 nonce ACK 相等、boot ID/generation
匹配，原十秒 wall/BOOTTIME TTL 有效，剩余约 9.41 秒。实际二进制/制品/登记哈希匹配，
唯一控制器、唯一 Badger writer、有效固定媒体根及原只读配置均通过。
内部 health healthy，最近完整 feed 发布成功为 15:20:59。

新进程自然运行完成 28 个 feed 更新、一次下载（15:20:20）、一次发布（15:24:25）和
一次上报（15:24:26）；截至 15:38:45，新 D1 warn/error 为 0。
未手动同步、重放未知请求或制造生产故障。

15:37:36 读到应用 2 文件、8 条、7,653 字节，覆盖 config、tombstone、metadata、event、
episode 和 Bilibili discovery；恢复器 1 文件、5 条、6,102 字节，覆盖 inspect、身份、
媒体探针、租约发布与准入转换。文件均 0600，allowlist/敏感字段检查通过。
所有已持久记录中的 dropped/write_failures 快照均为 0；这是落盘快照，
不是额外导出的实时计数端点。成功采样稀疏，读取文件未触发新业务或诊断记录。

首次自然 config 1,316ms（DNS 7、connect 3、TLS 528、首字节 751、读取 23ms）；
后续远端请求复用连接。首次 inspect 215.77ms，含 worker 启动；identity 231.61ms、
媒体探针 148.98ms、租约发布 105.98ms。完整首次准入约 3,034.54ms，
它包含多个步骤，不能与单次三秒观察预算混算。
本机合成 HTTP trace benchmark 为 1,584ns/op、2,248B/op、28 allocs/op，
不是生产负载基准，也不能从一次正常调用推断故障时开销。

应用两条 failure 是 discovery 的 HTTP 200 / provider_code -404，耗时 37/40ms、EOF 完整，
对应原有“不可用节目跳过”分支；两个原节目此前分别已有 25 次同类跳过。
相应 feed 随后于 15:19:44、15:20:28 完成发布，未产生 D1 节目终态失败。
没有证据证明两个不可用节目本身恢复，不能把 feed 成功当作该节目成功。
新进程尚无自然 Bilibili 无数据块失败样本，下载接线由实际制品和隔离回归证明。

两个最新媒体大小 14,021,850 / 15,954,171 字节，实际文件链接数 2；
源端 Range 206/1,024 字节，Mac/NAS 的原 RSS 均 200、enclosure 唯一且 length 正确，
两侧媒体 Range 206/1,024、总大小和前缀 SHA-256 与真实源一致。
Worker 两侧 200/ok、media healthz 204、dashboard 302 到原 Access。

NAS 首次新样本 RSS 再次出现 curl 35（约 3.08 秒），该次证据另存，未掩盖。
15:33 同条件有界复验两样本均通过，TLS 验证结果 0；RSS TLS 累计约 136–140ms。
原失败探针没有保留分段计时/错误细节，无法倒推其具体失败阶段。
只读取得 NAS curl 7.86.0 / OpenSSL 3.0.19、该 SSH 环境未设置代理环境变量且无默认 curlrc；
这不能排除其他网络中间层，也不足以证明 TLS 原因。
未更换 URL、修改 NAS 配置或关闭 TLS/Access。

## 最终滚动窗口与剩余问题

D1 窗口为 10/30 15:38:45 至 10/31 15:38:45（UTC 07:38:45 至次日同刻）。
按 run 开始时间为 24 轮：21 success、2 partial、1 running，累计 644 feed、22 下载、
25 发布、9 errors；各轮 sequence 唯一连续且计数相符。
按事件发生时间为 672 feed 成功、23 下载、26 发布、23 上报；
失败为下载 2、上报 3、tombstone 3、配置 1，共 9。
早间原第 3 个下载失败已滑出此窗口，历史 10 条错误仍保留，不能把窗口差当作删错或新增量。
新轮 28 feed / 1 下载 / 1 发布 / errors 0，latest event 15:34:49。
所有本轮 D1 SELECT 读回 rows_written 0。

新实例 stdout 截至 15:38 的留存为 warning 2（均上述既有 discovery 跳过），
error/fatal/panic 0。早间原日志归档只覆盖到 08:03:43，按当前 24 小时窗包含
warning 62、error 5、fatal/panic 0；其中远端事件 warn 9、metadata warn 13。
08:03:43 至 15:11:27 的旧容器 stdout 未完整留存，因此不能声称精确的全 24 小时
stdout warn/error/fatal/panic 总数或用 D1 无错替代这一缺口。D1 事件/轮次统计窗口完整。
这是本次重建前日志保全的遗漏。已对现有 `runtime/private/*podsync*` 的直接应用日志归档
做有界查找，未找到能覆盖缺口的旧实例日志；旧 ID 已移除，在已核对归档中无法追回。
未为取证重建/回滚当前服务。[部署流程](../../DEPLOYMENT.md)现将旧 ID 截至 drain 完成的
近 24 小时 stdout/stderr 归档、0700/0600 权限、摘要/时间范围及读回验证列为移除前必检；
归档验证失败须保留旧容器并暂停重建，避免再丢未保全证据。

Go fmt、golangci-lint（0 issues）、make test 通过；diagnostics/builder/remote/ytdl
聚焦 race 通过；隔离平台完整本地检查 29 条命令通过，包括旧 Inspector 默认协议兼容回归。
最终文档/登记另检查链接、JSON 语法、敏感字段与 diff；没有因文档更改重复整套 Go 测试。

本轮可验收的是诊断缺口修复及实际部署。旧共同 HTTP 超时、固定 ID 观察超时的具体阻塞点、
原无数据块下载诱因和两次 NAS TLS 失败原因仍未定位；原请求的服务端接收未知继续保留。
新故障从自然调用取得有界阶段证据后再判因；yt-dlp 内部网络分段和历史已轮转证据仍不可补造。
普通重试成功、healthy 或新增留证均不构成“彻底根治”。
