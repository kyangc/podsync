# 2026-11-14：远端事件最终 EOF 与持久队列自然恢复复核

时间均为 Asia/Taipei（UTC+8）。**02:12:46 的最终事件上传警告是新发生的逻辑调用失败；
原批次保留在持久 outbox，并由下一次自然 Flush 成功确认。** 其余内部 EOF 的原调用也已
恢复。逐字段对账未发现事件丢失、重复存储或计数失配，没有需要代码、配置或运行修复的缺陷。

本次仅增加复核文档，没有部署、重启、手工重放 POST、触发同步或修改重试、连接池、TLS、
Access、Cookie、队列、媒体、恢复历史及预算。网络触发者仍未定位。

## 六条内部诊断与一次最终失败

从原 `/app/db/diagnostics/failure-0.jsonl` 重新读取如下记录：

| 完成时间 | operation / `at_ns` | elapsed | stage / request_written |
| --- | --- | --- | --- |
| 11/13 12:03:21.293258571 | remote_tombstones / 1794542601293258571 | 28ms | tls / false |
| 11/14 00:52:54.279633417 | remote_config / 1794588774279633417 | 173ms | first_byte / true |
| 01:17:42.347023543 | remote_events / 1794590262347023543 | 195ms | first_byte / true |
| 02:12:44.486955910 | remote_events / 1794593564486955910 | 2329ms | first_byte / true |
| 02:12:46.111855369 | remote_events / 1794593566111855369 | 1373ms | tls / false |
| 05:08:42.346665652 | remote_events / 1794604122346665652 | 197ms | first_byte / true |

均为 EOF、HTTP 0、未收到响应头、正文 0、`context_state=none`，诊断 dropped/write-failure
快照均为零。除 02:12:46 外，连接获取一次、`trace_ambiguous=false`、剩余共享预算约
29999ms；00:52 的 client limit 为 35000ms，其余为 30000ms。

02:12 两条是同一逻辑调用的两次应用层尝试：第一条完成后间隔约 251ms 开始第二条，
第二条剩余预算 27418ms，随后 02:12:46.112354202 记录最终 `remote event upload failed`。
第二条 `connection_acquisitions=2`、`trace_ambiguous=true`；Transport 的多次连接获取
不能再算成两次应用重试，也不能凭最后的 tls 标记唯一定位故障阶段。请求写完不能证明
服务端未接收；本次无法区分首次已接收但响应丢失与后续尝试首次接收。

12:03 的白天样本已保存在昨晚恢复线程的诊断归档，但既有事故文档未单独闭合该调用，
本次补核其 cursor。它不是本次新增的最终失败。午夜四个逻辑调用窗口分别核对，
不能把六条内部诊断计成六次最终失败，也不能用昨晚恢复解释掉 02:12 的新警告。

## 原批次、失败保留与成功确认

[记录器](../../services/remote/events.go)先保存事件、序号和累计计数，再串行 Flush；
POST 返回成功后才移除相应前缀，并保存剩余状态，持久化失败则恢复内存前缀。
[HTTP 重试](../../pkg/httpretry/retry.go)在共享三十秒期限内最多尝试两次，间隔 250ms；
[client](../../services/remote/client.go)的同次重试复用同一批次。

本次只读流式扫描原 `000000.vlog` 的固定长度前缀，没有打开第二个 Badger 实例、获取
数据库锁、暂停 writer 或改写源文件。按锁定 Badger v1.6.2 格式核验 CRC32C、事务版本
和提交结束标记，仅导出已提交的有关记录：读取 439434914 字节、791287 条记录、
391996 个事务；末尾恰为已提交边界，没有未提交尾记录。读取前后源 inode、大小和
mtime 相同。这是历史 value-log 记录审查，不是运行中整个数据库的原生一致性快照。

| 原 EOF 窗口 | 原轮开始 | 原批次 sequence | Flush 保存 → 成功移除事务 | 原轮结果 |
| --- | --- | --- | --- | --- |
| 01:17:42 | 00:54:42 | 22–23 | 390104 → 390105 | success，117 条事件 |
| 02:12:44/46 | 01:55:42 | 17–18 | 390376；下一次 390381 → 390382 | success，117 条事件 |
| 05:08:42 | 04:58:42 | 9–11 | 391224 → 391225 | success，117 条事件 |

第一批是 01:16:44 的 tombstone fetched/applied；第三批是 05:07:54 的配置 fetched 和
tombstone fetched/applied。唯一非空 Flush 保存记录、事件产生时序、一分钟串行调用及
没有最终失败警告，共同支持它们在原逻辑调用内部恢复；并非只看后续其他批次成功。

02:12 的边界不同：原 17–18 来自 02:11:42 的空 tombstone 批次。最终警告之后，
事务 390377、390378、390380 仍保存完全相同的 17–18，同时依次新增 02:12:54/55 的
19–21。下一次 Flush 事务 390381 保存待发 17–21，390382 才将这五条成功移除。
随后三个空状态保存先于 02:16:42 的新事件；结合原一分钟 ticker、三十秒上限和没有
后续 Flush 错误，支持成功发生于下一次自然 02:13:42 Flush。事务本身没有墙钟时间，
直接可证的移除时间界限是 02:12:55 之后、02:16:42 之前，不能补造精确 ACK 时间戳。

三批原事件及成功扩大批次的全部九个事件字段，均按原 run/sequence 与 D1 逐项相同。
后续已提交记录没有重新出现这些序号，三个原轮最终均删除本地待发状态。D1 实际 schema
仍有 `UNIQUE(run_id, sequence)`；[Worker](../../cloudflare/worker/src/index.ts)采用
`INSERT OR IGNORE` 和累计计数取最大值。可确认最终内容与持久确认边界，不能还原原始
网络 payload、响应 JSON、服务端接收时间或实际去重次数；没有人为重放任何批次。

## 配置接受与 tombstone cursor

00:52:54 的内部配置 EOF 后，原调用在 00:52:55 产生 `remote_config_fetched` sequence
93；00:52:55.711066043 原日志记录 `refreshed feed configuration source=remote`。
刷新循环串行、间隔五分钟；该日志位于调度协调、SetFeeds、tombstone 同步和接受缓存
写入之后。窗口内没有 fallback、invalid、协调或缓存持久化警告。

随后 fetched/applied 为 sequence 94–95；cursor 事务 389923 保存 3487，
`updated_at=00:52:55.707418709`。白天 12:03:21 的 tombstone EOF 后，原调用于
12:03:22 产生 sequence 85–86，事务 387316 保存 cursor 3455，
`updated_at=12:03:22.050167821`；随后 12:03:51 又有独立配置刷新后的正常应用，
没有用后者替代前者的恢复证据。两次原调用均 `changes=0`，applied 次数不代表删除数。

08:03 缓存快照可解析为 TOML、10110 字节、28 feed，mtime 为 08:02:54.773025845；
最新已提交 cursor=3507、`updated_at=08:02:54.770939595`，等于当前 D1 高水位。
当前缓存不能逐字还原历史配置响应。

## 当前生产结果与验证

08:03 保存当前 writer 从昨晚 20:51:39 起的原 ID stdout/stderr，共 42916 条日志，
末条 08:02:54；窗口内最终远端上传警告仅上述一次，持久事件写入警告、fatal/panic 均零。
白天调用另读取旧 ID 已归档日志的原时间窗口。没有把当前容器日志冒充跨重启完整二十四小时
日志；停机及此前实例的完整日志边界沿用[昨晚恢复记录](2026-11-13-reboot-playback-recovery.md)
与本次父巡检的分段归档复核。

本次前两组十条 D1 SELECT 均成功、`rows_written=0`。近三十六小时 22 轮的序号均从
1 至 count 唯一连续，feed/download/upload/error 累计与对应事件相同；近二十四小时
完整 feed 成功 614，download/upload/report 各 32，配置 fetched 237。两条 feed 错误
仍是昨晚 20:52/53 已恢复样本，历史中断轮也保持原记录，没有新增业务终态失败。
最近完成轮 07:00:42–08:01:42 为 success，28 feed / 1 download / 1 upload / errors 0；
08:01:43 起的新轮刚开始，零 feed 不能作为卡死证据。

08:07 再读四条 SELECT，均 `rows_written=0`；新轮从一条自然推进至四条事件，
最新事件 08:02:54，22 轮序号及计数仍一致。昨晚 21:03 后没有 D1 warn/error 或失败
事件；08:03 首次取证后没有新增远端失败诊断、最终上传或事件持久化警告。
两份已验收媒体的远端身份、状态、大小及更新时间再次读回相同。

08:05 独立运行和交付验收：

- 原唯一登记 writer、唯一数据库运行消费者和应用 PID 1；producer/media 均 healthy，
  RestartCount 0，昨晚 StartedAt、原 ID 和规范化指纹保持。实际 arm64 应用、manifest
  哈希匹配登记源码 `19ce1ae`，相关处理源码与当前仓库无差异。
- 原控制器唯一、ready_since 仍为昨晚 20:51:39，attempts 与两个 streak 为零，
  inspection 历史 56。冻结制品哈希、config/state/activation 登记和源配置/Cookie
  哈希、mtime、只读挂载保持；昨晚 21:03 验收后没有新增宿主控制失败。
- 两个实际 v2 门禁保留入口至 `--`、仅以 `/bin/true` 替换后续业务命令，均返回 0。
  Linux lease 与完整 nonce ACK 相同，boot/generation 匹配；双时钟 TTL 各十秒、
  剩余约 8.746 秒。内部 health healthy、完整 feed 更新时间 07:54:39。
- 复核父巡检同两份最新自然媒体，大小 27137813 / 14765748 字节。Mac/NAS 四份 RSS
  均 200、目标 enclosure 唯一、length 等于 D1；四次 Range 均 206、1024 字节、总长
  正确且前缀 SHA-256 等于源文件。各有且仅有一个原下载文件同设备同 inode。
  双侧 Worker 200/ok、media healthz 204、未认证 dashboard 302 至原 Access、TLS
  校验通过；RSS 耗时 0.705–0.971 秒，没有重试或修改访问保护。

定向 Go 测试通过，覆盖共享重试期限、取消、丢响应后相同 POST payload、持久 outbox
失败保留与恢复、确认持久化失败回退、配置接受、tombstone 原子应用和 HTTP 诊断歧义。
Worker 事件批次十四项测试通过，包含重复投递与终态保护。测试验证现有处理契约，
不能重现历史网络条件；本次没有因此调整重试或生产运行。

私有原日志、诊断、CRC/事务扫描、逐字段对账、D1、缓存与交付证据保存在
`runtime/private/podsync-followup-20261114/`，目录 0700、文件 0600，附大小与 SHA-256
清单。本次仅文档变更，检查本地 Markdown 链接、脱敏与 git diff，无需完整 Go 测试或部署。
