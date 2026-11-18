# 2026-11-18：终态下载失败、事件 EOF 与墓碑超时复核

时间均为北京时间（UTC+8）。**原失败节目已由下一轮自然下载并交付，原事件批次已持久
确认，墓碑 cursor 与真实变更逐项一致，未发现持续数据缺口或需要实施的代码、配置、
运行修复。** 网络中断的底层触发者及首次写完请求是否已提交仍未知，不能将自然恢复
解释为网络问题已根治。本次只增加复核文档，未部署、重启、手工触发同步或重放请求。

本次是[11 月 17 日复核](2026-11-17-recovered-event-eof-and-download-alerts.md)之后的
新证据；13:23 的下载重试已在上游同步后的复核中见过，19:24 终态失败、21:22 重试
及次日 01:12 墓碑超时为后续新样本。旧 08:01:42 EOF 已在昨日闭合，不重复计为新增。

## 日志和失败分类

在干净的 `main` 上独立读取原 producer 截至正常 drain 的 stdout/stderr 归档和当前
producer 日志，查询窗口为 11/17 08:00 至 11/18 08:07:08。合计 91670 条，首条
08:01:06、末条次日 08:02:17，时间戳可解析。原 producer/media 四份归档流的大小与
SHA-256 均与归档回执相同；原 producer 退出 0，日志保留至 12:03:40 正常 drain。
当前日志保留 12:05 启动、12:10:40 正常停止及 12:21:40 重启，未只按最新 StartedAt
截断历史。停启属于受控部署与另行授权的平台维护，不能据此推定异常 writer 退出。

十条 error 是五次失败下载尝试的成对输出，不是十个失败节目。除去昨日已闭合的
08:01:42 EOF，58 条 warning 为同两个历史 Bilibili 样本的 50 次跳过、四次下载重试、
一次终态下载 summary、一次墓碑超时及两次最终事件 EOF。没有 fatal/panic 或远端
事件持久化失败警告，Bilibili 没有新 identity。

## 原节目成功链与实际交付

| 首次失败 | 阶段 / 分类 | 下载最终结果 | upload / report | 字节 |
| --- | --- | --- | --- | ---: |
| 11/17 13:23:40 | extract / tls_transport，metadata=false，31859ms | 第二次成功，13:24:45 | 13:26:44 / 13:26:45 | 17200124 |
| 19:24:13 | media / downloader_error，format 18，metadata=true，含 EOF | 本次三次失败；下一自然轮 20:24:29 summary、20:24:30 完成事件 | 20:26:45 / 20:26:46 | 16915801 |
| 21:22:26 | media / http_403，format 18，metadata=true，8440ms | 第二次成功，21:22:40 | 21:26:44 / 21:26:45 | 1035970 |

19:24 原样本在 19:23:08 发现，19:23:19/34 两次 TLS 重试分别耗时 10637/10026ms，
三次总计 64981ms；D1 仅有一个 `episode_download_failed`。20:23:55 原样本再次发现，
随后下载、发布、上报完整闭合，距首次发现约 1 小时 3 分 38 秒。原失败事件和原轮
`partial` 保留，没有以成功覆盖历史失败。另两个样本只有一条发现至上报链，没有
下载失败终态事件。

三个原发布任务分别在事务 414539、416542、416836 完成：`succeeded`、`visible`、
发布 attempts=1、LastError 空，原资产身份和大小与 D1 相同。发布次数与下载尝试
次数分开计。全量发布状态为 succeeded 2382、failed 8、pending 0；八项历史失败的
完整原值与昨日扫描相同，没有删除或重写它们。

08:10 双侧新验收包含三个异常节目、最新 YouTube 26320981 字节和最新 Bilibili
3832512 字节，共五份。Mac/NAS 十份 RSS 均 200，原 enclosure 恰一条、length 等于
D1；十次 Range 均 206/1024 字节，Content-Range 总长等于 D1，前缀 SHA-256 逐份
等于 Linux 容器实际源文件。源大小正确，各有且仅有一个同设备同 inode 的 feed
硬链接。两侧 Worker 200/ok、media healthz 204、匿名 dashboard 302 至原 Access，
TLS 校验全部通过；没有只以 `visible` 判定交付。

## 原事件批次和持久确认

新增远端失败诊断为 remote_events EOF 六次尝试、remote_config EOF 一次及墓碑
deadline 一次。08:21:42 和 11:01:42 每次两条尝试各对应一个最终警告：第一次均为
first_byte、request_written=true、HTTP 0；第二次为 TLS EOF。08:21 第二次有两个
连接获取且 trace_ambiguous=true，11:01 第二次为单连接。连接数不是应用重试次数。
次日 01:07:44、04:12:44 的 event EOF 和 04:17:17 的 config EOF 均在写完请求后
等待首字节时结束，没有终态警告；诊断 dropped/write-failure 快照均为零。

只读扫描原 `000000.vlog` 固定长度前缀，按锁定 Badger v1.6.2 格式校验 CRC32C、
事务版本和结束标记，没有打开第二个 Badger、获取数据库锁或暂停 writer。完整状态
扫描读取 467076977 字节、846797 条记录、419644 个完整事务，无未提交尾记录；源
inode、大小和 mtime 前后相同。这是历史 value-log 对账，不是运行库的原生一致性快照。

| 原 EOF 窗口 | 原轮开始 | 原序号 | Flush 保存 → 下一次保留 → 成功移除事务 | 原轮结果 |
| --- | --- | --- | --- | --- |
| 11/17 08:21:42 | 07:56:42 | 22–26 | 412918 → 412919 → 412920 | success |
| 11:01:42 | 10:59:42 | 2–6 | 413699 → 413700 → 413701 | success |
| 11/18 01:07:44 | 00:32:44 | 32–36 | 417811 → 417812 | partial，另有墓碑失败 |
| 04:12:44 | 03:35:45 | 37–41 | 418645 → 418646 | success |

前两批在最终警告后的下一次 Flush 保存中原字段完整保留，随后才移除；确认分别早于
08:25:42、11:05:42 的新事件。结合一分钟 ticker 和没有后续警告，支持自然 08:22:42、
11:02:42 Flush 恢复，事务本身没有墙钟，不能补造精确网络 ACK 时刻。后两批紧接着
持久确认，支持原逻辑调用内部重试成功。原序号确认后没有再出现，四个原轮最终均
删除本地待发状态。查询窗口全部 2940 个事件的九个字段与 D1 按 run/sequence 一致。

[记录器](../../services/remote/events.go)只在 POST 成功后移除前缀，确认持久化失败会
恢复内存前缀；[HTTP 重试](../../pkg/httpretry/retry.go)共享三十秒期限并复用原批次。
Worker 保留 `UNIQUE(run_id, sequence)`，使用 `INSERT OR IGNORE`。这些证据能证明
最终内容和本地持久确认，不能还原首次服务端接收时间、首次请求提交结果或去重次数。
本次没有人为重放。

## 墓碑真实变更与配置恢复

01:12:14 原墓碑失败为 first_byte deadline，30001ms，context_state=deadline，
request_written=true、HTTP 0。失败前 cursor 为 3631（01:07:17.498，事务 417809）；
期间没有 cursor 提交，下一次自然成功在 01:12:18.800（事务 417820）仍为 3631。
D1 原失败序号 37 和后续 config/fetched/applied 序号 38/39/40 均保留。

远端变更 3626–3631 创建于 11/17 20:17:05.999，下一条 3632 直到 11/18 02:17:05.965
才产生；原失败窗内高于 3631 的真实变更为零。没有把空 fetched/applied 当作删除数，
也没有只因后续成功就推断原响应内容。

窗口内真实变更 3605–3650 共 46 条，每条 feed/episode、sequence、status、action、
created_at 与本地 marker 相同；marker 的 applied_at 与同事务 cursor 提交时间一致，
对应 cursor 覆盖该 sequence。当前 cursor 3650 等于远端高水位，无漏应用证据。
[本地应用](../../pkg/db/remote_tombstone.go)将 marker、待发发布任务处理和 cursor
放在同一事务中；失败响应本身仍未知，原错误不删除。

04:17:17 的 config EOF 后，原调用在 04:17:19 接受远端配置，同步墓碑 cursor 3650
提交于事务 418656。没有 fallback、invalid、协调或缓存持久化警告；当前缓存可解析，
10110 字节、28 个 feed。

## 收尾生产读回和边界

08:11 收尾 D1 四条 SELECT 均 rows_written=0。近 36 小时 37 轮序号从 1 连续、唯一，
feed/download/upload/error 累计均与事件计数一致。最近完成轮为 06:38:44–07:39:44，
success、28 feed / 1 download / 1 upload / 0 errors；当前 07:39:45 开始轮从初次
读取的 26 条自然推进至 31 条事件，仍 running、业务计数零，未声称它已经完成。
完整 feed 成功时间为 07:24:03，metadata 07:24:02，最新远端事件 08:07:17。
08:07 初次取证之后没有新失败诊断、最终 warning 或业务失败事件。

收尾固定前缀扫描读取 467078000 字节、846803 条 CRC 正确记录、419647 个完整
事务，无未提交尾记录，源 inode、大小和 mtime 前后相同。当前唯一活动 run 的
next_sequence=32、pending=0，全部累计字段与收尾 D1 的 31 条事件相同。

08:08 与 08:11 两次运行验收均通过：唯一登记 writer、唯一运行 DB 消费者、应用
PID 1；producer/media 原 ID 与指纹匹配、healthy、RestartCount 0；实际二进制及
source manifest 与登记 commit `6a66af4` 匹配。恢复器唯一、approved/ready、attempts
和两个 streak 为零、inspection 历史 56；冻结制品、配置/激活哈希及源配置/Cookie
哈希、mtime 和只读挂载保持。五条宿主过渡失败均为受控停启、unknown_write=false，
没有新控制失败。两个实际 v2 门禁均通过，Linux lease 与完整 nonce ACK、boot 和
generation 匹配，墙钟与 BOOTTIME 固定十秒 TTL 有效，采样剩余约九秒。

六个 Go 包定向测试通过，覆盖重试期限、取消、丢响应后相同 payload、持久确认回退、
墓碑事务、诊断歧义及下载重试；Worker 事件批次与墓碑两组共 23 项测试通过。
这些检查验证现有契约，不能重现历史外部网络。没有证据将 TLS EOF、首字节 EOF、
403 和墓碑超时归为同一根因，也不能因时序相邻归责上游同步或 VM 重启。

私有日志、原诊断、固定前缀扫描、逐项对账、双侧交付、运行读回与校验清单位于
`runtime/private/podsync-followup-20261118/`，目录 0700、文件 0600。本次仅文档变化，
检查 Markdown 链接、脱敏与 git diff；不需要完整 Go 测试或生产部署。历史失败、
未知结果、任务身份、源 Cookie、媒体、恢复历史和预算保持。
