# 2026-11-19：下载器更新限流与 metadata EOF 复核

时间均为北京时间（UTC+8）。**GitHub 版本查询已恢复，现有 yt-dlp 与最新 stable
均为 `2026.10.26`；原 metadata EOF 已定位到 `mengmiancaijing`，原轮成功、
本地发布持久状态与远端内容一致。未发现需要实施的代码、配置或运行修复。**
本次没有重跑生产更新命令、触发同步、重放 metadata、部署或重启。
原自动更新失败不改写为成功；首次 metadata 请求是否已提交及 EOF 的责任方仍未知。

本次接续[11 月 18 日复核](2026-11-18-recovered-download-event-and-tombstone-alerts.md)。
昨日下载、事件和墓碑的恢复结论不变，不能因今日错误计数下降而宣称网络已根治。

## 日志范围和分类

独立读取原 producer stdout/stderr，查询 11/18 08:00 至 11/19 08:03:53；
88454 条日志首条为 11/18 08:02:17、末条为 11/19 08:02:17，全部可解析。
同一 producer 会话自 11/17 12:21:40 运行，没有新生命周期中断或跨实例缺口。
其中 info 88404、warning 48、error 2、fatal/panic 0；完整 feed 更新 672、
远端配置接受 289 次。

两条 error 属于同一次更新检查：一条完整命令输出、一条上层 `update failed`。
48 条 warning 均为同两个历史 Bilibili 不可用 identity，与昨日保全样本集合相同，
没有新 identity。应用失败诊断只有旧 Bilibili -404 共 48 次及本次 metadata EOF
一次，没有新下载失败、下载重试、最终 metadata/事件/墓碑警告或事件持久化警告。
读取到的诊断 dropped/write-failure 计数均为零。

## 更新失败原因、当前版本与后续行为

11/18 12:21:44 开始的实际命令为 `--update --verbose`，12:21:45 退出 100。
输出明确记录当前 `stable@2026.10.26`，访问
`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest` 时收到
`HTTP Error 403: rate limit exceeded`。这证明失败发生在 GitHub release API
版本查询阶段，不能归因 TLS、Bilibili 或下载媒体。原日志没有配额响应头，无法
确定共享出口中哪个调用者耗尽了额度。

11/19 08:04 在**原 Linux producer**中，从实际 `/usr/local/bin/youtube-dl`
导入其自带的 `yt_dlp.update.Updater`，仅调用 `query_update(_output=True)`。
使用原请求实现、网络环境和插件，禁用 Python 字节码及缓存写入；没有调用
`update()`，也没有下载或替换程序。原版本查询 API 返回 200，响应 Date 为当时
UTC 时间，`X-RateLimit-Limit=60`、`X-RateLimit-Remaining=58`，解析到的最新
stable 仍为 `2026.10.26`，内部返回码 0、无可用更新。随后再运行原程序
`--version`，退出 0、版本相同；查询前后程序 SHA-256、inode、大小和 mtime 相同。

这些证据闭合的是**当前查询恢复且没有漏装较新 stable**，不是一次后续自动更新
成功记录，更不保证共享出口永不再被限流。[更新入口](../../pkg/ytdl/ytdl.go)与
[后台循环](../../pkg/ytdl/auto_update.go)在失败后保留现有程序，在本次结束 24 小时
后再次检查，预计今日约 12:21:45；下载、playlist 和更新共用可取消的串行锁。
现有机制没有快速重复请求，当前也没有版本缺口，因此不增加凭据、缩短检查间隔
或绕过原锁手工更新。更新失败后的生产下载、发布和实际交付另行验收，不能由
版本命令成功替代。

## 原 metadata 身份、持久状态和响应边界

原异常结束于 11/19 00:22:57.994：`remote_metadata`、first_byte、171ms、
HTTP 0、request_written=true、response_headers=false、单连接、复用连接、
trace_ambiguous=false、context_state=none。它只证明请求写完后没有读到响应头，
不能定位客户端、链路或远端责任，也不能判断远端是否先完成提交。

身份关联不只使用相邻时间：[主循环](../../cmd/podsync/main.go)串行消费 feed 更新，
[更新器](../../services/update/updater.go)先 AddFeed，再同步等待 metadata 上报，
之后才进入下载和 XML/OPML 发布。原窗口的串行链、本地原 feed 记录及 D1 原
run/sequence 一致；672 次完整更新的开始/结束均无重叠。

| 原证据 | 对账结果 |
| --- | --- |
| feed 更新开始 / 完成 | `mengmiancaijing`，00:22:56.532 / 00:22:59.056 |
| discovery 事务 | 424417，原 feed identity、来源、标题等完整保留 |
| 发布检查点事务 | 424418，`last_successful_update=00:22:59.054854658` |
| D1 原轮 | 11/18 23:55:44 开始，最终 success、errors_count=0 |
| 原事件 | sequence 68 started、69 finished，feed identity 相同 |
| finished 事件持久确认 | 424419 保存、424457 待发前缀移除，原轮最终删除本地待发状态 |
| 当前原 feed metadata | 07:23:20 上报，12 个内容字段与原 discovery 及最新本地记录一致 |
| 当前本地发布检查点 | 07:23:20.738718351 |

原值来自只读扫描原 `000000.vlog` 的固定长度前缀；按锁定 Badger 格式校验
473825737 字节、860377 条记录、426410 个完整事务，CRC32C 和结束标记正确，
无未提交尾记录，源 inode、大小、mtime 前后相同。没有打开第二个 Badger、获取
数据库锁或暂停 writer。这是历史 value-log 对账，不是原生一致性快照。

原逻辑调用没有 `remote feed metadata upsert failed` 最终警告；
[客户端](../../services/remote/client.go)只有在 2xx 响应 JSON 的 `ok=true` 且
feed_id 匹配后才返回 nil。[HTTP 重试](../../pkg/httpretry/retry.go)对 EOF 在
同一个三十秒期限内等待 250ms，最多再尝试一次，复用原 metadata 和 reported_at。
结合完整日志、串行调用顺序与后续发布，**支持本次逻辑调用内部重试成功**。
当前 D1 的 identity、provider、source_url、title、description、image_url、link、
author、category、language、explicit、last_source_update_at 均与原本地内容一致；
reported_at 已由后续自然更新推进，未冒充原请求时间。

metadata 没有单独的持久 ACK，成功诊断仅按 operation/小时采样，原重试的响应没有
独立留存。因此上述内部重试成功属于源码与完整日志支持的推断；本地 feed 检查点
和**事件**待发前缀确认不能充当 metadata ACK。不能还原首次请求的精确提交结果、
原响应内容、第一次远端接收时间或责任方。当前远端内容一致和后续自然发布已经
读回，没有据此补造缺失证据或人为重放。

## 业务交付与收尾验收

08:03 初次、08:07 及 08:09 收尾的 D1 SELECT 均 success、rows_written=0。
近 36 小时 36 轮序号从 1 连续、唯一，feed/download/upload/error 汇总与事件
计数一致。查询窗口内 feed 成功 672、下载/上传/report 各 20，warn/error/failed
事件为零。窗口内开始的 24 轮为 23 success / 1 running，累计 feed 644；多出的
28 个 feed 事件来自窗口前开始的旧轮，没有计数矛盾。

巡检交接时仍 running 的 07:02:44 轮，现已在 08:03:44 自然完成，success、
28 feed / 2 download / 2 upload / 0 errors。08:03:44 开始的新轮仍 running，
业务计数仍为零，事件从 1 条自然推进至 6 条，不能称已完成；下一次定时 feed
更新尚未到期。08:07 新配置已自然接受，未见卡住或新失败。最近完整 feed 更新
07:24:07，最新 metadata 07:24:07；收尾最新已刷远端事件 08:07:17，原 feed
metadata 内容保持一致。

08:05 从 Mac 与 NAS 独立重验最新 YouTube 24973450 字节及 Bilibili 16174068
字节：四份 RSS 均 200，原 enclosure 恰一条，length 等于 D1；四次 Range 均
206/1024 字节，Content-Range 总长正确，双方前缀 SHA-256 等于 producer 实际源
文件。源大小匹配，每份 feed 目录仅一个同设备同 inode 的对应硬链接。
两侧 Worker `/health` 200/ok、media `/healthz` 204、匿名 dashboard 302 到原
Cloudflare Access，TLS 校验全部通过。

08:05 和 08:09 两次运行读回：唯一登记 writer、唯一运行 DB 消费者，应用 PID 1；producer/media
原 ID 和指纹匹配、healthy、RestartCount 0、无 OOM，实际二进制及 source manifest
匹配登记 commit `6a66af4`。恢复器唯一、approved/ready、attempts 和两个 streak
为零，inspection 历史 56；冻结制品及配置/激活哈希匹配。原源配置/Cookie 的
哈希、mtime 和只读挂载保持。近 24 小时宿主失败诊断为零。两个实际 v2 gate
均通过；完整 Linux nonce ACK 与 lease、boot、generation 一致，墙钟和 BOOTTIME
固定十秒 TTL 有效，采样剩余分别约 9.6 / 9.7 秒。保留原 ready_since、恢复历史和预算。

四个 Go 包定向测试通过，覆盖更新循环、重试期限、取消、metadata 映射与响应
校验；Worker metadata 接口 11 项测试通过。私有隔离 HTTP harness 让真实
`NASClient.UpsertFeedMetadata` 首次读完请求后丢响应，验证两次 payload 逐字节
一致、第二次合法响应被接受；没有重放生产请求。这验证既有契约，不重现历史
外部网络或证明原请求的提交结果。

本次仅文档变更，检查 Markdown 本地链接、脱敏与 git diff，无需完整 Go 测试或
生产部署。私有完整日志、诊断、GitHub 查询回执、固定前缀扫描、逐项对账、双侧
交付和运行读回保存在 `runtime/private/podsync-followup-20261119/`，目录 0700、
文件 0600；原失败、任务/outbox 身份、源 Cookie、媒体、恢复历史及预算保持。
