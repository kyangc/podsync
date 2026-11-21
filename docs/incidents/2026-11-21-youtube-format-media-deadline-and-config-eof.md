# 2026-11-21：YouTube 格式、媒体期限与配置 EOF 分项复核

时间均为北京时间（UTC+8）；节目身份以 A/B 代替。原失败属于两个新节目，
不与[11/20 记录](2026-11-20-youtube-bot-rejections-and-media-timeout.md)中的节目合并。

## 结论与处理状态

三次终态下载失败为 A 的一次 bot 登录确认拒绝、一次媒体阶段进程 deadline，
以及 B 的一次格式不可用。两个原身份均已自然下载、发布、上报；本次独立核对了
完整事件链、本地持久发布状态和双侧实际媒体交付，没有当前交付缺口。

原配置 EOF 后，同次逻辑调用恢复的证据包括原窗口事件及其持久确认，
不只依赖后来其他调用成功。首次请求已经写出却未收到响应，其远端处理结果仍未知。

没有发现应用终态计数、重试、发布或配置恢复缺陷；没有改代码、配置、鉴权、
选择器、出口或期限，没有部署、重启或人为重放生产任务。此次匿名提取暂时成功，
不能认定 bot 限制、格式可用性波动或慢媒体传输的底层触发原因已经根治。

## 原失败、实际耗时与恢复

| 样本 | 原尝试 | 终态证据 | 同身份后续成功 |
| --- | --- | --- | --- |
| A | 11/20 09:23:16 发现，09:23:25 失败 | extract、metadata=false、attempts=1；总计 9362ms、进程 9359ms；明确 bot 登录确认拒绝 | 11:23:08 再发现；11:45:28 summary 成功、11:45:29 下载完成，11:46:44 上传、11:46:45 上报；16963385 字节 |
| A | 10:23:16 重试，10:53:16 失败 | media、format 18、HTTPS、mp4a.40.2、metadata=true；总计 1800035ms、进程 1800016ms；deadline_exceeded | 与上一行同一节目，不额外计作一个失败节目 |
| B | 22:33:36 发现，22:33:40 失败 | extract、metadata=false、attempts=1；3999ms；原输出明确 Requested format is not available | 23:22:22 再发现；23:50:45 下载、23:51:44 上传、23:51:45 上报；35521210 字节 |

A/B 从首次发现至上报分别为 2 小时 23 分 29 秒、1 小时 18 分 9 秒，存在真实历史延迟。
原三条 `episode_download_failed` 和三个 partial 轮均保留。

A 的成功轮下载列表有两个节目：index 0 于 11:23:08 开始，11:38:38 成功，
耗时 930059ms；A 是 index 1，实际到 11:38:38 才开始，自身进程为 410090ms
（约 6 分 50 秒），summary 总计 410091ms。发现至开始之间约 15 分 30 秒来自
同 feed 的顺序处理，不能将发现至完成的约 22 分钟全部算作 A 的媒体耗时。
其 `queue_wait_ms=0` 仅描述下载器锁等待，不覆盖尚未调用下载器的前序处理。

B 的成功进程为 1703296ms、总计 1703297ms，约 28 分 23 秒，距三十分钟期限
仅约 97 秒；同样 queue_wait=0、format 18、HTTPS、mp4a.40.2、complete。
该值包含提取、媒体和后处理，不能当作精确的媒体传输时间或转码时间。

## bot、格式选择与当前探针

A 首次原输出在 mweb player API 后明确要求 bot 登录确认，没有格式 metadata，
也未记录进入媒体阶段。B 原输出则已记录 bgutil GVS PO Token 生成、player 脚本及
Deno 求解，随后报格式不可用；没有 bot 提示，也没有 EOF，不能合并归因。
这些步骤日志本身不证明上游最终接受了 Token。

原基础配置、故障前缓存归档和当前接受缓存一致。A/B 均为 channel discovery、
audio/high、1h、page_size 25，没有 YouTube `cookie_profile` 或 Cookie 参数。
现有凭据仍只有 Bilibili；本次未取得 YouTube 登录会话，也未抓取浏览器凭据。
API discovery 成功与下载播放器鉴权是不同请求路径。

最后一个 `--format` 覆盖[默认音频选择器](../../pkg/ytdl/ytdl.go)，实际为：

```text
18/best[protocol=https][vcodec!=none][acodec!=none]
```

client=mweb，socket timeout=12 秒，媒体和 fragment retries 各 1，进程期限三十分钟。
该 fallback 要求 HTTPS 且同时含音视频，不会选择纯音频。实际安装的 yt-dlp 在
格式选择结果为空时产生原错误；原失败没有打印可用格式列表或保存 player 响应，
因此不能还原当时哪些格式、URL、Token 或客户端条件缺失。

08:06 在原 Linux producer、原网络和实际 yt-dlp 2026.10.26 中对 B、A 顺序做有界
simulate/skip-download 提取；禁用磁盘 cache，不获取媒体、不发布任务。两次分别约
4759/3602ms，mweb player 均为 OK。B 当前为 was_live、时长 3692 秒，A 为 not_live、
1742 秒；这是当前快照，不能倒推 B 昨晚失败时是直播处理延迟。

同一返回快照中，B/A player 各有 1 个普通格式及 31/37 个 adaptive 条目；提取器最终
均只提供 format 18 和四个无音视频的 storyboard。format 18 为 360p、avc1.42001E +
mp4a.40.2，正规化协议为 HTTPS；当前报告源大小分别为 123973798/79922816 字节。
这些是当前视频格式大小，不是已发布 MP3 大小，也不是原失败时的传输字节数。

两者均提示部分 mweb HTTPS 格式因缺少 URL 被跳过，并提出 SABR-only 实验的可能性；
不能将该提示当作原失败的确定根因。在同一快照分别运行原选择器和 `bestaudio/best`，
两者都选择 format 18，没有得到可验证的纯音频替代方案，故未据猜测修改生产选择器。
本次未复现原格式失败或 bot 拒绝，不能把当前提取成功外推为持续解除限制。

## 媒体 deadline 的已知与未知

A 第二次原输出明确已选 format 18 并写入临时 mp4，最后阶段为 media，没有
ExtractAudio/Merger；错误链保留 `context deadline exceeded`。期限从实际命令执行
开始，[管理器](../../services/update/updater.go)不会对已终止进程额外快速重试，
保留 EpisodeError 交给下一自然轮。不能归为排队、前一次 bot 拒绝或已证实的转码超时。

失败 output_bytes=84155、output_truncated=false；但现有输出处理会主动过滤百分比
进度，“未截断”不表示保留了媒体进度。没有原完成比例、吞吐、最后数据到达时间、
逐请求时序、CDN 响应、出口记录或临时媒体，不能唯一归责源端、网络、出口或 I/O。
B 后续接近期限的成功也不能补造这些数据。socket timeout=12 秒不等于整个下载总期限。
没有延长期限、增加媒体重试或重新下载已交付媒体来掩盖这一边界。

## 原配置 EOF 与持久恢复证据

11/20 20:12:16.977 的 remote_config EOF 为 first_byte、137ms、HTTP 0，
复用连接、单次连接获取、request_written=true、response_headers=false、
trace_ambiguous=false，drop/write-failure 快照为零。它表明写完请求后未获得响应头，
不能归为尚未提交请求或已收到完整配置；底层断开位置和首次请求处理结果仍未知。

[配置读取](../../cmd/podsync/remote_config.go)使用 GET，
[内部重试](../../pkg/httpretry/retry.go)对 EOF 在共享三十秒预算内最多两次，
间隔 250ms。原配置刷新是串行五分钟周期，原轮在 20:12:17 的序号 34 记录
`remote_config_fetched`，20:12:18 的序号 35/36 为 tombstone_fetched/applied；
没有该次最终刷新、缓存 fallback 或缓存写入警告。

固定 value-log 前缀内，三条原事件分别在提交 436729/436730/436732 持久保留，
字段与 D1 原 run/sequence 逐一相同；提交 436734 后从待发内容移除。
这证明原窗口事件已持久化并获事件上报确认。`remote_config_fetched` 只有在配置
HTTP 读取、解析与校验成功后记录；结合串行调用和时间，支持原逻辑调用内部重试恢复，
不是借用下一轮或无关成功。但事件上报 ACK 不是第一次配置请求的响应 ACK。

08:10 以应用实际 User-Agent 做只读认证 GET，远端响应 200，完整 10110 字节与
当前接受缓存以及 11/20 08:11 的故障前缓存归档逐字节相同，均有 28 个 feed，
SHA-256 为 `be7d829c869fee268263c417a0e51a409ae0adad4bf02dbba9766874975a63be`。
D1 启用 feed 的最后更新时间早于故障，下载默认值仍为 12/1/1。
没有原单次响应的内容哈希，不能声称已逐字节证明 20:12 的返回正文；原窗口恢复
判断另有上述持久事件和代码路径支撑。当前 GET 不用于消除首次未知结果。

## 持久状态、双侧交付与生产读回

只读扫描原 `000000.vlog` 的固定 487564831 字节前缀，未打开第二个 Badger 或获取锁。
887692 条记录及 440006 个事务通过 CRC32C/提交标记核验，无未提交尾记录；
扫描前后 inode、大小、mtime 相同。这是 value-log 历史审查，不是运行中全库一致性快照。

A/B 最新发布提交分别为 434368/437822，均 succeeded、server_status=visible、
attempts=1、LastError 空，资产身份、大小与 D1 相同。十四条原发现/失败/下载/上传/上报
事件逐字段匹配本地持久保留记录及后续待发移除边界；发布 attempts 不冒充下载尝试。
发布状态总计 succeeded 2444、failed 8，没有 pending；八项是保留的历史失败。
采样时当前轮待发事件为零，未清理 outbox 或错误记录。

08:07 对 A/B 和巡检原选定的最新 YouTube 26773501 字节、Bilibili 13722612 字节
共四份媒体独立验证：Mac/NAS 八份 RSS 均 200，原 enclosure 各恰一条，length 等于 D1；
八次 Range 均为 206/1024 字节，Content-Range 总长匹配，双方前缀 SHA-256 等于
物理源文件；源大小匹配，每个 feed 目录只有一份同设备同 inode 的硬链接。
两侧 Worker health 200/ok、media healthz 204、匿名 dashboard 302 至原 Access，TLS 校验通过。

08:07 运行读回仍为原 producer，实际二进制及 source manifest 与登记 commit `6a66af4`
和 arm64 镜像匹配；唯一数据库消费者为 podsync，应用 PID 1，四个相关容器 healthy。
两个消费者 RestartCount=0、无 OOM，登记 ID/指纹、冻结制品、配置及激活哈希一致。
恢复器 approved/ready、attempts 和 inspection/observation streak 为零，历史 inspection 仍 56。
近窗口宿主控制失败为零；完整 Linux nonce ACK、boot/generation、固定双时钟十秒 TTL
有效，两个消费者实际 v2 gate 均通过。源配置及 Cookie 哈希、mtime、只读挂载保持。

## 自然轮、检查与剩余边界

08:04 独立读取 11/20 08:00 至采样时刻 stdout/stderr 共 89459 条：info 89402、
warning 51、error 6，fatal/panic 和时间解析错误为零。六条 error 为三次终态下载失败
各自的执行错误/输出；warning 为三条 summary 和同两个旧 Bilibili 样本的 48 次跳过，
不重新派发旧身份。没有新 feed、上传、上报、配置、墓碑或事件上传最终错误，亦无重启。

初次九条及原样本补充六条 D1 SELECT 均 rows_written=0。近 36 小时 36 轮的序号
均从 1 连续且唯一，feed/download/upload/error 汇总与各轮事件相同。
固定巡检起点至初采样的 feed 成功 672，下载/上传/上报各 22，下载终态失败 3；
按窗口内开始轮汇总的 feed 644 少 28，来自窗口前开始的旧轮，不是计数矛盾。

08:13 收尾查询仍无新增 warning/error 事件，原四份媒体行相同。
最近完成轮为 06:49:45–07:50:44，success、28 feed/1 下载/1 上传/0 错误；
07:50:45 开始的当前轮仍 running，序号已至 26、最新事件 08:12:17，
0 feed/0 下载/0 上传/0 错误，不能计为完成。此时尚未到约 08:23 的下一批 feed 调度；
末次完整 feed/metadata 为 07:23:49，无卡住证据。原三条终态失败未增长，
没有新自然下载，不能据此保证后续新节目不再遭遇限制。

五个 Go 包 `pkg/ytdl`、`services/update`、`cmd/podsync`、`pkg/httpretry`、
`pkg/diagnostics` 测试通过，覆盖格式/bot 分类、期限/取消、进度过滤、配置内部重试与
缓存回退、HTTP 诊断。它们验证应用行为，不能证明历史网络责任方。本次仅仓库文档变更，
另检查链接、敏感信息及 git diff，不需要部署。

精确原身份、完整日志、D1、固定前缀扫描、逐事件对账、格式探针、双侧交付及实际门禁
证据保留在 `runtime/private/podsync-followup-20261121/`，目录 0700、文件 0600，
附大小/SHA-256 清单。仍缺原失败格式/player 响应、媒体进度/出口记录及可用于登录
对照的 YouTube 会话；当前成功不补足这些边界，也不重复索取已授予的修复权限。
