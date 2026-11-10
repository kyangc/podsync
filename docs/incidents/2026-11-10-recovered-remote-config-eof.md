# 2026-11-10：远端配置内部 EOF 自然恢复复核

时间均为 Asia/Taipei（UTC+8）。**11/9 两条新增 `remote_config/eof` 是配置读取内部
尝试失败，均已由既有机制恢复；原配置读取最终成功、应用并写入接受缓存，对应同步轮
正常完成。** 未发现需要代码、配置或运行修复的稳定缺陷。本次仅记录证据，没有部署、
重启、手工重跑同步或改变重试预算。恢复结论不代表历史 EOF 的底层原因已定位。

## 原始诊断与调用边界

原应用 `/app/db/diagnostics/failure-1.jsonl` 的两条记录为：

| 字段 | A | B |
| --- | --- | --- |
| 完成时间 | 11/9 20:01:54.520750074 | 11/9 20:36:54.543135076 |
| `at_ns` | 1794225714520750074 | 1794227814543135076 |
| elapsed / budget / client limit | 141 / 29999 / 35000ms | 164 / 29999 / 35000ms |
| stage / context state | first_byte / none | tls / none |
| request written / response headers | true / false | false / false |
| connection reused / acquisitions | true / 1 | false / 2 |
| trace ambiguous | false | true |
| first byte / TLS | 140 / -1ms | -1 / 150ms |
| HTTP status / body bytes | 0 / 0 | 0 / 0 |
| dropped / write failures | 0 / 0 | 0 / 0 |

[配置读取](../../cmd/podsync/remote_config.go)在每次 `fetchRemoteConfigOnce` 内建立诊断，
覆盖一个 `client.Do` 及响应正文读取；外层调用[既有 HTTP 重试](../../pkg/httpretry/retry.go)。
该重试仅对 EOF 等瞬态错误，在共享 30 秒期限内最多尝试两次，间隔 250ms；
不会重试普通 HTTP 状态错误、配置校验或证书错误。配置 client 自身限制为 35 秒。
因此不能把两条内部诊断算成两次最终配置获取失败，亦不能把 B 的两次连接获取算成
两次应用层重试。

[HTTP 观察器](../../pkg/diagnostics/http.go)只聚合现有 `httptrace` 回调，不替换 Transport、
连接池或 TLS。A 证明客户端已完成请求写入、未收到响应头；它不能证明服务端未收到请求。
B 的同一次 `client.Do` 出现多次连接获取，明确标有 trace 歧义；最后的 `tls` 标记及累计
150ms 不能唯一定位底层阻塞，也不能还原 Transport 内部的请求/拨号顺序。
两者均在约 30 秒预算尚未耗尽时返回 EOF，没有 context 超时或取消。

原记录没有 endpoint、请求 ID、包级轨迹或服务端日志。不能唯一归因供应商、网络、NAS、
平台资源或 TLS；资源快照与阶段耗时也不足以证明或排除某个短暂底层触发者。

## 原调用最终成功、配置接受与缓存边界

按精确时间关联原进程日志与 D1：

| 原失败 | D1 `remote_config_fetched` | 原日志 `refreshed feed configuration source=remote` | 下一次自然获取 |
| --- | --- | --- | --- |
| A | 20:01:55，sequence 19 | 20:01:55.795360950 | 20:06:54，sequence 24 |
| B | 20:36:55，sequence 118 | 20:36:55.709382076 | 20:41:54，sequence 123 |

两条 D1 回执都属于同一原同步轮。单个刷新循环串行执行；下一轮定时获取间隔五分钟，
上表成功均紧跟原内部失败。[事件记录](../../cmd/podsync/remote_events.go)仅在获取和配置
解析/校验成功后产生 `remote_config_fetched`，不是单纯 HTTP 200 回执。
[主循环](../../cmd/podsync/main.go)随后完成调度协调、`manager.SetFeeds`、tombstone 同步
及接受缓存写入，再记录 `refreshed feed configuration`。两窗口及整个近 24 小时均无最终
刷新、调度协调或接受缓存写入错误，也无配置 fallback/invalid 事件。这些边界共同证实
原调用经既有 EOF 重试恢复并接受配置，不能只用后续其他 feed 更新作此推断。

B 另保留一条原成功诊断：开始于 20:36:54.793768243，距失败完成 250.633167ms；
20:36:55.402031910 完成，耗时 608ms、HTTP 200、10110 字节、正文完整 EOF、关闭成功，
trace 无歧义。该时间及剩余共享预算 29584ms 与既有第二次尝试一致。
A 的成功尝试未保留独立 baseline：成功诊断按 operation 最多每小时采样一次，
失败诊断仍逐条保留；不能补造 A 的成功传输阶段或精确耗时。

08:19 只读保存的当前接受缓存为可解析 TOML、10110 字节、28 个 feed，mtime 为
08:16:55.437675562，与最新自然配置应用一致；SHA-256 保存在私有证据中。
缓存只保留最新内容，原事件/日志不保存历史响应正文哈希或配置版本，因此不能据当前
缓存宣称已逐字还原 A、B 当时的配置内容或证明两个响应版本相同。
缓存快照没有触发额外配置获取或配置应用。

## 同步影响与真实生产验收

08:19 的六条 D1 SELECT 全部成功且 `rows_written=0`：

- 两次失败对应原轮 11/9 19:43:37–20:44:36 为 success，28 feed / 2 download /
  2 upload / 0 error；125 条事件的 sequence 1–125 唯一连续。
- 近 36 小时 36 轮均 sequence 从 1 至 count 唯一连续，feed/download/upload/error
  计数与事件一致。近 24 小时事件为 672 次完整 feed 成功、各 18 次下载/发布/上报成功、
  288 次配置获取成功，warn/error 与业务失败事件为零。
- 最近完成轮为 06:54:37–07:55:36，success、28 / 1 / 1 / 0；当前轮自 07:55:37
  正常 running，28 / 0 / 0 / 0、80 条事件，最新事件 08:16:55、metadata 08:12:59。

08:19 本线程独立读回：原 producer/media 消费者均 healthy、RestartCount 0，
StartedAt 仍为 11/8 09:10:32/33，ID 与登记指纹一致；单登记 writer，数据库 volume
的运行消费者仅 producer，应用进程仅 PID 1。原控制器唯一、ready_since 仍为
11/8 09:10:33，attempts 零、两个 streak 零、inspection 历史 56。

双实际门禁均返回 0；探针保留原入口至 `--`，完全替换其后业务命令为 `/bin/true`。
Linux v2 lease 与完整 nonce ACK JSON 相同，boot ID、generation 匹配当前会话，
wall/BOOTTIME 固定 TTL 各十秒、剩余各约 9.434 秒。内部 health healthy，最近完整
feed 更新 08:12:59；实际 arm64 二进制/manifest 哈希符合部署登记 `9efb508`，冻结控制
制品哈希匹配，源配置/Cookie 哈希、mtime 与只读挂载保持。
11/8 09:34 验收后现存宿主诊断没有新控制失败；原 ACK、TTL、两秒发布预算及 SSH/观察
期限不变。这不能证明旧 APFS 停顿或首个媒体 probe 的未知触发者已根治。

08:20 独立复核父巡检同一对最新自然发布样本（27585653 / 28550964 字节）：

- Mac/NAS 四份 RSS 均 200、目标 enclosure 唯一、length 与 D1 相同。
- 四次 Range 均 206、1024 字节、总长正确，TLS 校验通过；双侧前 1024 字节 SHA-256
  均与 producer 源文件相同。源大小与 D1 一致，每份恰有一个原下载文件同设备、同 inode。
- 双侧 Worker 200/ok、media healthz 204，未认证 dashboard 302 至原 Access。

原 ID 日志查询为 11/9 08:19:39–11/10 08:19:39，保存并读回 84277 条可解析 logfmt，
首条 11/9 08:21:55、末条 11/10 08:16:55；完整 feed 成功 672、配置应用 source=remote
288，fatal/panic/error 均零。运行会话未跨重启，查询边界到首末业务日志的自然间隔不作为
日志缺口。stdout 仅有原两个不可用 Bilibili 样本的 48 条跳过告警；同一近 24 小时的
failure 分段记录除本次两条 EOF 外仅上述 48 条 -404，没有新增 Bilibili API 失败或其他
内部远端失败。

## 留证与验证

原日志、失败及成功诊断、原调用上下文、缓存快照、D1、实际运行与双侧交付读回保存在
内置盘 `runtime/private/podsync-followup-20261110/`，目录 0700、文件 0600；清单逐项
记录大小与 SHA-256。没有打开运行中 Badger 的第二个实例，没有改变任务、未知结果、
事故历史或预算。

相关配置读取、事件、HTTP 重试及诊断源码与实际部署 `9efb508` 一致。
现有定向 Go 测试通过：瞬态重试与取消/共享期限、正文截断后重试、持续失败保留缓存、
配置校验与接受缓存、事件映射、HTTP 阶段/多连接歧义和正文错误保留。它们验证本地处理
边界，不重放历史网络条件。命令与结果保存在私有验证回执中。
本次仅新增事故文档，检查本地 Markdown 链接、脱敏和 git diff；无需完整 Go 测试或部署。
