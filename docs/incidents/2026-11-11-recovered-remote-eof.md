# 2026-11-11：远端事件、配置与 tombstone 内部 EOF 复核

时间均为 Asia/Taipei（UTC+8）。**今日新增七条内部 EOF 均已由既有机制恢复，
没有最终远端调用失败或已观察到的事件丢失、重复。** 三批事件已按原轮次、序号、
完整事件字段与持久 outbox 移除记录核对；三次配置已接受、应用，一次 tombstone
已提交本地 cursor。未发现需要代码、配置或运行修复的稳定缺陷。

本次没有部署、重启、手动重跑同步、重放 POST 或调整预算；仅补充复核记录。
恢复结论不代表历史 EOF 的底层原因已定位，也不能确定首次 POST 是否已被接收。

## 原始七条内部尝试

原记录位于应用 `/app/db/diagnostics/failure-0.jsonl`，与昨日两条配置 EOF 不同：

| operation | 完成时间 | `at_ns` | elapsed |
| --- | --- | --- | --- |
| remote_events | 05:01:36.869479714 | 1794344496869479714 | 206ms |
| remote_events | 06:01:36.864967139 | 1794348096864967139 | 204ms |
| remote_config | 06:01:54.604340856 | 1794348114604340856 | 225ms |
| remote_tombstones | 07:41:54.992659759 | 1794354114992659759 | 24ms |
| remote_events | 07:46:36.872001643 | 1794354396872001643 | 213ms |
| remote_config | 07:46:54.578604902 | 1794354414578604902 | 200ms |
| remote_config | 07:51:54.553471503 | 1794354714553471503 | 174ms |

七条均为 `stage=first_byte`、`context_state=none`、`request_written=true`、
`response_headers=false`、HTTP 0、body bytes 0；连接复用、单次连接获取、
`trace_ambiguous=false`。共享剩余预算均为 29999ms，client limit 分别为事件/
tombstone 30000ms、配置 35000ms，诊断 dropped/write-failure 快照均为零。
它们表明客户端写完请求后未收到响应头，不能证明服务端未接收请求。

[远端 client](../../services/remote/client.go)与[配置读取](../../cmd/podsync/remote_config.go)
在每次内部尝试内建立诊断，再由外层[HTTP 重试](../../pkg/httpretry/retry.go)
处理 EOF 等瞬态错误：共享 30 秒期限、最多两次、间隔 250ms。
诊断不是逻辑调用的最终结果；Transport 内部的连接获取亦不是应用重试次数。
没有保留紧接这七条失败的独立成功 baseline，不能补造第二次尝试的传输阶段或精确耗时。

复用连接上的自然断连是可能解释，现有数据不足以唯一定位触发者。没有原端点请求 ID、
服务端或包级轨迹；不能归因于 NAS、TLS、平台资源，亦不能把 RSS 延迟与这些 EOF
认定为同一根因。未向生产注入故障来重现历史网络条件。

## 三批事件 POST 与持久 outbox 对账

[事件记录器](../../services/remote/events.go)先保存事件和累计计数，串行 Flush
在 POST 成功后才移除对应前缀，再持久化剩余状态；失败保留原序号和内容。
同一次 HTTP 重试复用同一批次。Worker [事件写入](../../cloudflare/worker/src/index.ts)
采用 `INSERT OR IGNORE`，本次 D1 实际 schema 也读回确认 `UNIQUE(run_id, sequence)`；
累计计数取最大值，重复投递不会把计数再次累加。

为补齐历史 outbox 边界，本次只读流式扫描原 `000000.vlog` 当时的固定长度前缀，
没有打开 Badger 实例、获取其锁、暂停 writer 或改写源文件。按仓库锁定的 Badger
v1.6.2 格式逐记录核验 CRC32C、同事务版本与结束标记，仅导出已提交的有关记录。
共读取 423163270 字节、验证 758408 条记录与 375644 个事务，末尾恰为已提交边界，
没有未提交尾记录；读取前后源 inode/大小/mtime 相同。
这是历史 value-log 记录审查，不冒称运行中整个数据库的原生一致性快照。

按唯一非空持久前缀、事件产生时间与下一事件之间的一分钟串行 Flush 关联原调用：

| 原 EOF | 原轮开始 | 原批事件 sequence | 保存待发 → 成功移除的事务版本 | D1 与后续状态 |
| --- | --- | --- | --- | --- |
| 05:01:36 | 04:15:37 | 47–48 | 374838 → 374839 | 完整字段相同；原轮 success、119 条事件；本地原轮最终删除 |
| 06:01:36 | 05:16:36 | 45–46 | 375123 → 375124 | 完整字段相同；原轮 success、120 条事件；本地原轮最终删除 |
| 07:46:36 | 07:18:37 | 27–28 | 375671 → 375672 | 完整字段相同；当前轮持续推进；该前缀已移除 |

三批各有两个事件，均为 `tombstone_fetched` / `tombstone_applied`，事件时间分别为
05:00:37、06:00:37、07:45:37。逐项比较全部事件字段，不仅检查序号连续；
后续已提交 outbox 记录没有重新出现这三组序号。移除记录均早于下一次配置事件
（05:01:54、06:01:55、07:46:55），结合串行 Flush、无最终上传/持久化警告，
支持原逻辑调用在该次 Flush 内恢复，不能仅用之后其他批次成功推断。

原始网络 payload、响应 JSON 和服务端接收时间没有留存。上述映射来自持久记录与
运行时序，不能声称还原了原始报文，或区分第一遍已提交但响应丢失与第二遍首次提交。
无需也没有人为重放这三批；D1 最终内容和 outbox 确认边界已经闭合。

## 配置接受与 tombstone cursor

| 原配置 EOF | D1 `remote_config_fetched` | 原日志 `refreshed feed configuration source=remote` |
| --- | --- | --- |
| 06:01:54 | 06:01:55，sequence 47 | 06:01:56.318061107 |
| 07:46:54 | 07:46:55，sequence 29 | 07:46:56.162819278 |
| 07:51:54 | 07:51:55，sequence 34 | 07:51:55.912845129 |

配置刷新循环串行，间隔五分钟；这些成功属于原失败调用。事件仅在配置读取、解析和
校验成功后记录；[主循环](../../cmd/podsync/main.go)随后完成调度协调、SetFeeds、
tombstone 同步与接受缓存写入，再记录刷新完成。全窗口无 fallback/invalid、调度协调
或缓存写入警告。08:07 缓存快照为合法 TOML、10110 字节、28 feed，mtime 为
08:06:55.132716474；它只证明当前接受缓存，不能逐字还原三个历史响应的配置版本。

07:41:54 的 tombstone EOF 后，07:41:55 出现同原调用的 fetched/applied 回执。
已提交 cursor 记录为 3398，`updated_at=07:41:55.830908551`，先于 applied 事件，
与[应用事务](../../pkg/db/remote_tombstone.go)成功后才记录 applied 的边界一致。
08:06:55.129430849 又自然提交同值；D1 tombstone 高水位亦为 3398。
原调用返回 `changes=0`，本次为空批应用；applied 事件次数不能当实际删除数。

## 生产结果与验证边界

08:07–08:10 的两组共十一条 D1 SELECT 全部成功、`rows_written=0`：

- 近 36 小时 35 轮的序号均从 1 至 count 唯一连续，feed/download/upload/error
  累计计数与对应事件数一致；近 24 小时完整 feed 成功 672，download/upload/report
  各 18，配置获取 288，warn/error 与业务失败事件均为零。
- 最近完成轮 06:17:36–07:18:36 为 success，28 feed / 2 download / 2 upload /
  errors 0，125 条事件。当前轮自 07:18:37 起，08:07 读回 51 条事件、最新 08:06:55；
  与父巡检 08:04 的 46 条相比继续自然推进。其 feed/download/upload 暂为零，
  不能据此判定卡死；最新 metadata/完整 feed 为 07:13:56。

08:13:49 再以三条只读 SELECT 复核，均 `rows_written=0`：当前轮已自然完成
28 feed / 0 download / 0 upload / errors 0，112 条事件序号连续且计数相符，
最新事件 08:13:00、metadata 08:12:59。08:07 后原日志新增 28 次完整 feed 成功、
一次配置应用；没有新增远端失败诊断、最终远端调用警告或 D1 warn/error 事件。

本线程另保存并完整解析原 ID 的近 24 小时日志：查询 11/10 08:07:39 至
11/11 08:07:39，共 84689 条 logfmt，首末为 08:11:54 与次日 08:06:55。
完整 feed 成功 672，远端配置应用 288，fatal/panic/error 均零，最终远端调用警告零。
48 条 warning 仍只涉及昨日同两个不可用 Bilibili -404 样本，不是七条 EOF 的最终警告。

08:08 独立运行验收：唯一登记 writer、数据库 volume 的运行消费者仅 producer，
应用仅 PID 1；producer/media 都 healthy，RestartCount 0，StartedAt 保持 11/8
09:10:32/33，ID 和登记指纹相同。原控制器唯一、ready_since 为 11/10 19:24:04，
attempts 与两个 streak 为零、inspection 历史仍 56；宿主诊断没有新增失败。
原共享锁等待后的同会话重新验证不是本次业务故障，没有清除历史或预算。

两个实际 v2 门禁（保留原入口到 `--`、仅以 `/bin/true` 替换业务命令）均返回 0。
Linux lease 与完整 nonce ACK 相同，boot/generation 匹配，双时钟 TTL 各十秒、
剩余约 9.714 秒；内部 health healthy。实际 arm64 二进制与 manifest 哈希匹配登记
应用 `9efb508`，冻结控制制品、源配置/Cookie 哈希与 mtime、只读挂载均保持。

08:08 双侧交付复核父巡检同两份最新自然媒体（13385820 / 27899802 字节）：
Mac/NAS 四份 RSS 均 200、enclosure 唯一、length 等于 D1；四次 Range 均 206、
1024 字节、总长正确，前缀 SHA-256 均等于 producer 源文件。源大小正确，每份恰有
一个原下载文件同设备同 inode。双侧 Worker 200/ok、media healthz 204，未认证
dashboard 302 至原 Access，TLS 校验通过。沿用原 curl 期限，无失败重试。
本次四份 RSS 完成时间 0.68–0.85 秒，没有重现父巡检的一次 29.70 秒成功响应；
这不能定位或排除该次短暂延迟的触发者。

私有原日志、诊断、CRC/事务扫描结果、D1、缓存和交付证据保存在内置盘
`runtime/private/podsync-followup-20261111/`，目录 0700、文件 0600，并保存大小与
SHA-256 清单。没有清理任务、未知结果、outbox、历史记录或媒体。

相关运行源码与部署 `9efb508` 无差异。定向 Go 测试通过，覆盖共享期限/取消、
POST 丢失响应后相同 payload 重试、持久 outbox 保留与恢复、tombstone 应用、
配置接受及诊断边界；Worker 事件批次 14 项测试通过，包含重复投递与终态保护。
这些本地测试验证处理契约，不能重放历史网络条件。本次仅新增文档，检查本地
Markdown 链接、脱敏及 git diff，不需要完整 Go 测试或生产部署。
