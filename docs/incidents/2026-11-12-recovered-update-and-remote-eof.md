# 2026-11-12：下载器更新限流与远端内部 EOF 复核

时间均为 Asia/Taipei（UTC+8）。**一次下载器自更新检查遇到 GitHub 403 限流，
没有导致节目下载失败；两条新增内部 EOF 已由既有机制恢复。** 原事件批次与 D1、
持久 outbox 移除边界已核对，配置已接受、应用并完成缓存写入。未发现需要代码、
配置或运行修复的持久缺陷，本次仅补充复核记录。

没有部署、重启、手工更新下载器、重跑同步或重放 POST，也没有调整 Cookie、
网络、TLS、Access、门禁及重试预算。恢复结论不代表历史网络触发者已定位。

## 一次更新检查失败，不是两次独立失败

11/11 09:10:39.886582881 开始自然自更新；09:10:41.114530882 的下载器输出报告
GitHub 版本元数据获取遇到 HTTP 403，错误说明为 `rate limit exceeded`，退出码 100。
09:10:41.114549965 的 `update failed` 是外层对同一错误的记录，不能重复计数。
原命令为 `--update --verbose`，获取端点为
`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`。

从容器实际 `/usr/local/bin/youtube-dl` ZIP 读取的 updater 表明，版本查询失败即返回，
尚未进入下载与替换程序文件的步骤。[Podsync 更新入口](../../pkg/ytdl/ytdl.go)
保留旧下载器并释放串行锁；[后台循环](../../pkg/ytdl/auto_update.go)在该次操作结束
24 小时后继续检查，不会因一次错误退出。相关源码与生产应用 `9efb508` 一致。

保留的自然日志中，11/9 09:10:37、11/10 09:10:39 的同一检查均成功，确认 stable
版本为 `2026.10.26`。11/12 08:19:35 在原 Linux 容器中，使用已安装 yt-dlp 的
HTTP 实现、同一元数据 URL 与 updater 三个原请求头，只读获取一次元数据：

- HTTP 200，838ms；stable 最新 tag 仍为 `2026.10.26`，等于实际安装版本。
- 响应 `x-ratelimit-limit=60`、`remaining=59`、`used=1`、`resource=core`。
- 未调用 updater、获取更新资产或替换二进制；读取前后程序 SHA-256 和 mtime 相同，
  沿用默认 TLS 验证，未增加凭据或改变网络设置。

这证明当前版本查询可用且当时没有版本落后，不能据此补造昨日 403 的响应头。
原输出未保存该响应的限额/reset、请求 ID 或出口身份，无法唯一确定限流来源、
共享出口调用者或主/次级限额；[GitHub 官方限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
也要求结合响应头判断。本次不强制安装或更换更新渠道，下一次自然检查仍按原周期。
失败后已有 26 次下载、发布和上报成功，没有对应业务失败事件。

## 两条内部 EOF 与原调用结果

原记录位于应用 `/app/db/diagnostics/failure-1.jsonl`，不是昨日样本的滚动残留：

| operation | 完成时间 | `at_ns` | elapsed / client limit |
| --- | --- | --- | --- |
| remote_events | 11/12 05:16:36.827837967 | 1794431796827837967 | 167 / 30000ms |
| remote_config | 11/12 05:16:54.544841850 | 1794431814544841850 | 163 / 35000ms |

两条均为 `first_byte`、`context_state=none`、剩余共享预算 29999ms，复用连接、
单次连接获取、`trace_ambiguous=false`；请求已写完，未收到响应头，HTTP 0、正文 0。
diagnostics dropped/write-failure 快照均为零。它们不能证明服务端未收到请求。

[远端 client](../../services/remote/client.go)和[配置读取](../../cmd/podsync/remote_config.go)
在每次内部尝试内记录诊断，再由[HTTP 重试](../../pkg/httpretry/retry.go)在共享
30 秒期限内最多尝试两次、间隔 250ms。失败诊断不等于逻辑调用最终失败。
这两个失败后没有保留紧接的独立成功 baseline，不能补造成功尝试的传输阶段或耗时。

复用连接自然断连是可能解释；缺少原请求 ID、服务端和包级轨迹，无法唯一定位。
不能将 EOF 归因于 GitHub、NAS、TLS 或资源压力，也不能与更新限流认定为同一根因。

## 原事件批次与持久 outbox

复用昨日审查工具，只读流式扫描原 `000000.vlog` 的固定长度前缀，没有打开第二个
Badger 实例、获取数据库锁、暂停 writer 或写入源文件。按锁定 Badger v1.6.2 的
格式核验 CRC32C、事务版本和结束标记，仅导出已提交的相关记录。
共读取 430172590 字节、核验 772968 条记录与 382890 个事务，固定前缀末尾恰为
已提交边界、无未提交尾记录。源 inode 保持不变，扫描期间文件正常追加 342 字节；
这不是运行中整个数据库的原生一致性快照。

05:16:36 的原轮从 04:39:37 开始，唯一非空待发前缀是 05:15:37 产生的两个事件：

| 原批次 | 保存待发事务 | 成功移除前缀事务 | 后续结果 |
| --- | --- | --- | --- |
| sequence 93–94，tombstone_fetched / tombstone_applied | 382097 | 382098 | D1 全事件字段相同，无再次出现；原轮 success、119 条事件，本地原轮最终删除 |

原保存与移除记录的 run 摘要、next_sequence 相同，移除后才产生 05:16:55 的配置
事件 95。结合[串行 Flush](../../services/remote/events.go)、一分钟原定时调用，
以及全窗口没有最终上传或持久化警告，确认原逻辑 POST 在该次 Flush 中恢复，
并非仅凭连续序号或后续其他批次成功作推断。

D1 实际表结构仍为 `UNIQUE(run_id, sequence)`；Worker
[写入逻辑](../../cloudflare/worker/src/index.ts)使用 `INSERT OR IGNORE`，累计计数取
最大值。原批次全部事件字段与持久记录逐项相同，后续已提交记录未重新出现 93–94，
没有已观察到的丢失、重复或计数失配。原网络 payload、响应 JSON 与服务端接收时间
没有留存，不能区分首次已接收但响应丢失，还是第二次首次接收；没有人为重放批次。

## 配置、缓存与 cursor

05:16:54 的内部配置失败后，同轮 sequence 95 `remote_config_fetched` 为 05:16:55；
原日志在 05:16:56.100249143 记录 `refreshed feed configuration source=remote`。
刷新循环串行且间隔五分钟；事件在读取、解析及校验成功后产生，刷新日志位于调度协调、
SetFeeds、tombstone 同步与接受缓存写入之后。全窗口没有 fallback/invalid、
调度协调、缓存写入或最终刷新错误，支持原调用恢复并完成接受。

紧接的 tombstone fetched/applied 为 sequence 96–97、05:16:56；已提交 cursor
事务 382101 为 3440、`updated_at=05:16:56.096800309`，与该时刻 D1 高水位一致，
原空批 `changes=0`。08:18 缓存快照为合法 TOML、10110 字节、28 feed，mtime 为
08:16:55.089720417。当前缓存不能逐字还原历史配置响应正文。

取证时看到 D1 当前高水位 3444，而固定前缀中的最新 cursor 仍为 3440。进一步只读
核对确认 3441–3444 是 08:17:05.912 新增的四条变化；自然轮询在 08:20:37 记录
`changes=4` 并 applied 3444。仅追加扫描原边界后的 6239 字节，核验 28 条记录、
12 个事务，读回已提交 cursor 3444、`updated_at=08:21:55.048501352`，与当前高水位
相同。该差异是取证快照和正常轮询的时间边界，无需触发额外同步。

## 生产验收与留证

08:18 独立保存原 ID 近 24 小时日志，查询 11/11 08:18:33 至 11/12 08:18:33，
完整解析 85279 条 logfmt，首末为 08:21:55 与次日 08:16:55。完整 feed 成功 672、
远端配置应用 288，fatal/panic 零；两条 error 仅上述一次更新失败。
48 条 warning 仍是既有同两个不可用 Bilibili -404 样本。会话没有跨重启；
首末业务日志与查询边界的自然间隔不作为日志缺口。

只读 D1 核对近 36 小时 35 轮：序号均从 1 至 count 唯一连续，累计 feed/download/
upload/error 与对应事件一致；近 24 小时完整 feed 成功 672、download/upload/report
各 26、配置获取 288，warn/error 与业务失败事件零。原 EOF 所在 04:39:37–05:40:36
轮为 success、28 feed / 0 download / 0 upload / errors 0。

08:22 后续自然进展读回：当前轮自 07:42:36 起，28 / 0 / 0 / errors 0，94 条连续
事件、最新 08:20:37；08:18 时为 92 条。最新 metadata/完整 feed 为 08:12:56，
最近完成轮 06:41:36–07:42:36 为 success、28 / 2 / 2 / errors 0、128 条事件。
观察期间无新增远端失败诊断、最终远端警告或 D1 warn/error，配置继续自然应用。

实际生产验收通过：

- 唯一登记 writer，`podsync-db` 运行消费者仅 producer，应用仅 PID 1；producer/media
  healthy、RestartCount 0，原 ID、指纹及 11/8 StartedAt 保持。
- 原控制器唯一、ready、attempts 与两 streak 为零，inspection 历史 56；冻结制品
  哈希匹配，没有新增宿主控制失败。实际 arm64 二进制/manifest 匹配登记 `9efb508`。
- 双实际 v2 门禁仅以 `/bin/true` 替换 `--` 后业务命令，均返回 0；Linux lease 与
  完整 nonce ACK 相同，boot/generation 匹配，双时钟 TTL 十秒、剩余约 8.819 秒。
  内部 health healthy，源配置/Cookie 哈希、mtime 与只读挂载保持。
- 父巡检的两份最新自然媒体仍为 26263273 / 7739028 字节；Mac/NAS 四份 RSS 均
  200、目标 enclosure 唯一、length 等于 D1，耗时 0.705–0.784 秒。四次 Range 均
  206、1024 字节、总长正确、前缀 SHA-256 等于源文件；每份恰有一个原下载文件同
  设备、同 inode。双侧 Worker 200/ok、media 204、未认证 dashboard 302 至原 Access，
  TLS 验证通过；随后 D1 再读原样本仍 visible、大小相同，最新自然样本未更换。

私有原日志、诊断、固定前缀与追加段审查结果、D1、缓存、更新元数据及交付证据在
内置盘 `runtime/private/podsync-followup-20261112/`，目录 0700、文件 0600，
保存大小与 SHA-256 清单。查询仅 SELECT，逐项确认 `rows_written=0`。
保留原任务、outbox 身份、未知结果、历史与预算。

相关运行源码与部署 `9efb508` 无差异。定向 Go 测试通过，覆盖重试共享期限/取消、
相同 POST payload 重试、持久 outbox、配置接受、tombstone、HTTP 诊断及下载器
自更新生命周期；Worker 事件批次 14 项测试通过。这些测试验证处理契约，不能重放
历史网络条件。本次仅文档变更，检查 Markdown 链接、脱敏和 git diff，无需完整 Go
测试或生产部署。
