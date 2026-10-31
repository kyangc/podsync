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
