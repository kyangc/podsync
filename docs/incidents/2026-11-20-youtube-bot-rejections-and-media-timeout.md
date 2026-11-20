# 2026-11-20：YouTube bot 拒绝、媒体期限与 403 分别复核

时间均为北京时间（UTC+8），节目身份以 A/B/C 代替，不包含账号、订阅、媒体完整地址或凭据。

## 结论与处理状态

四条终态下载失败来自两个节目：三次 player 提取时的 bot 确认拒绝，以及一次已经进入媒体
阶段的三十分钟进程 deadline。另一个节目的媒体 403 在同次操作第二次尝试成功，没有终态
下载失败事件。三个原身份随后均自然完成下载、发布和上报，双侧实际交付已独立读回。

**bot 限制仍可复现，不能结为根因已解决。** 11/20 08:14 在原 Linux producer 对 A/B/C
各做一次不下载媒体的提取，仍全部返回相同 bot 拒绝；08:15 对 A 分别改用默认 client 和
显式 web，也同样失败。没有发现应用漏重试或发布状态缺口；没有修改代码、生产配置、
格式、鉴权、出口或预算，也没有部署、重启、补报或人为重放生产任务。本次保留调查边界，
未将新探针错误混入原四条业务失败。

## 原失败、正常调度与影响

| 样本 | 原发现 / 尝试时间 | 失败证据 | 后续原身份成功 |
| --- | --- | --- | --- |
| A | 11/19 09:23:13 发现；09:23:16、10:23:18 失败 | 两次均 extract、metadata=false、attempts=1，进程 2709 / 2899ms；player API 后明确 bot 确认拒绝 | 11:23:09 再发现，11:44:23 下载；11:46:44 上传、11:46:45 上报，18904292 字节 |
| B | 13:22:57 发现；13:23:00 失败 | extract、metadata=false、attempts=1、2896ms，同类 bot 拒绝 | 15:23:08 再发现，15:26:12 下载；15:26:45 上传/上报，22274699 字节 |
| B | 14:23:17 再发现；14:53:17 失败 | media、format 18、HTTPS、mp4a.40.2、metadata=true，进程 1800015ms、总计 1800036ms、deadline_exceeded、attempts=1 | 与上一行是同一个节目，不能额外算成第三个失败节目 |
| C | 20:22:51 发现；20:22:59 首次失败 | media/HTTP 403、format 18、metadata=true、8560ms；next_attempt=2、max_attempts=3 | 20:27:46 同次操作成功，attempts=2、总计 295061ms；20:31:44 上传、20:31:45 上报，13396987 字节 |

A、B 从首次发现至上报分别约 2 小时 24 分、2 小时 4 分。原四条
`episode_download_failed` 和四个 partial 轮均保留；C 只有一个最终下载完成事件。

独立读取原 producer 的 11/19 08:00 至 11/20 08:11:55 stdout/stderr，共 88970 条，
首条 08:02:17、末条次日 08:07:17，时间戳均可解析。info 88907、warning 53、error 10，
fatal/panic 为零。十条 error 是五次失败尝试各自成对的执行错误/输出；warning 为四条
终态 summary、C 的一次 403 重试，以及两个历史 Bilibili 不可用样本的 48 次跳过。
没有将旧 Bilibili 身份重新算作新故障。该窗口没有重启、生命周期切换、事件最终上传、
metadata、墓碑或 feed 更新最终警告。启动日志已轮转，当前版本另由原启动归档及实际制品核对。

## bot 拒绝：可复现现象与鉴权边界

三次原输出依次为 webpage、mweb client config、mweb player API JSON，随后缺少 player
title 的 warning 和明确的 bot 登录提示。没有格式 metadata，也没有到达日志中的 GVS
PO Token 生成、JS challenge 或媒体阶段。实际安装的 yt-dlp 提取器从 player
`playabilityStatus` / error renderer 读取原因，再追加通用登录提示；该提示本身不能证明
某份 Cookie 失效，亦不能唯一证明 IP 限流或 provider 故障。

读取基础配置、已接受远端缓存及 D1：

- A/B/C 均为 channel discovery、audio/high、周期 1h、page_size 25。频道发现通过
  [YouTube API builder](../../pkg/builder/youtube.go)，本次没有 discovery 失败；API key
  与下载播放器会话分属不同请求路径，发现成功不证明媒体提取通过。
- 三者没有 `cookie_profile`、`--cookies`、浏览器 Cookie 或用户名参数。基础配置只有
  Bilibili profile，凭据挂载中也只有原 Bilibili Cookie。不是已配置 YouTube Cookie 的
  过期复核；没有把 Bilibili 凭据用于 YouTube，也没有从浏览器提取新凭据。
- 实际选择器仍为 `18/best[protocol=https][vcodec!=none][acodec!=none]`，覆盖默认
  `bestaudio`；client=mweb，socket timeout 12 秒，媒体/fragment retries 各 1，
  每个下载进程上限三十分钟。D1 两条原 feed 配置更新时间均早于此次故障。
- 原 producer 的 yt-dlp 为 2026.10.26、Deno 为 2.7.4，加载 bgutil HTTP 插件 2.0.2；
  sidecar `/ping` 返回 200/version=2.0.2。它的 logging driver 为 none，无法补读
  原时间窗口的 provider 请求或 Token 结果；当前健康也不能替代历史请求证明。

五次当前只读提取均在原容器和网络执行，禁用磁盘 cache，使用 simulate/skip-download，
没有下载或发布媒体。前三次保持原 client 和 feed 参数，约 3.20 / 2.86 / 2.92 秒返回
bot 拒绝；仅对 A 移除显式 client 或改为 web 的对比，约 2.97 / 1.98 秒仍返回同类拒绝。
默认 client 的日志实际尝试 tv samsung；不能把“默认”误写成 mweb。正常配置加载与
ignore-config 的格式、鉴权、headers、proxy、extractor、重试、后处理及路径选项相同。
这一反馈循环重现了当前拒绝，未重现历史成功/失败切换的完整外部条件。
08:22 对 A 再做一次只保留返回状态的进程内观察，实际 mweb player JSON 为
`LOGIN_REQUIRED`、reason 为 bot 确认、无 streamingData。观察器命令成功只表示取证完成，
不表示播放器允许下载；这个新响应也不能补造三次历史 player JSON。

容器没有显式 proxy 环境或参数，但 YouTube 当前解析到 fake-IP 地址；空 proxy 配置不能
证明绕过透明出口。本次未取得原失败请求的规则命中、实际出口节点、player 原响应和
上游连接记录，不能归责某个节点、账号、YouTube 风控触发者或新版本回归。默认/web
也失败，故没有据单一 client 猜测改生产。当前缺少可用的 YouTube 登录会话及失败时
出口证据，不能验证持续解除 bot 限制；后续成功不能关闭这个边界。

## 媒体 deadline 与 403

B 的第二次失败已有 PO Token 生成和 Deno 求解步骤日志，随后选到 format 18、写入
临时 `.mp4`。最后阶段为 media，没有观察到 ExtractAudio/Merger。queue_wait_ms=0，
进程耗时约三十分钟；原输出末尾和错误链均为 `context deadline exceeded`，与
[下载器进程期限](../../pkg/ytdl/ytdl.go)一致。这是命令执行期间耗尽期限，没有证据支持
归为排队等待、前一轮 bot 拒绝或转码超时。

该尝试记录 output_bytes=83971、output_truncated=false。百分比进度在保留输出前已按
现有规则过滤，原媒体完成比例、有效吞吐、最后一次数据到达时间和逐请求耗时无法补造；
不能仅据字节计数判断完全卡死，也不能把 socket timeout=12 秒当作整个下载的总期限。
缺少原 CDN 响应、网络时序及临时媒体，本次无法唯一确定是慢速传输、源端节流、出口、
局部 I/O 或其他责任方；没有为绕过这一边界延长预算或重下载已交付媒体。

C 原输出明确为媒体 `HTTP Error 403: Forbidden`。约五秒退避后重新启动下载，第二次
耗时 281496ms，最终只记录一次下载成功。没有原 403 响应头/正文、签名 URL、Token
验证结果或 CDN 边缘日志，不能确认签名过期、Token/session、IP 变化或地区策略；
当前同一节目出现 bot 拒绝也不能倒推原 403 与 bot 属于同根因。

[下载管理器](../../services/update/updater.go)现有策略为 403/TLS/明确耗尽内部重试的
媒体读取超时最多三次，退避 5 秒/30 秒；纯登录/bot 拒绝及进程 deadline 不额外快速
重试，保留 EpisodeError 供下一自然轮处理。本次原始五份失败输出通过临时测试设施
回放到实际管理器调用路径：三个 bot 和一个带原期限原因的失败各调用一次并产生
恰好一个失败事件；403 后模拟成功则调用两次、恰好一个完成事件。未发现分类或终态计数缺陷。

## 持久状态与实际交付

只读扫描原 `000000.vlog` 固定前缀，未打开第二个 Badger、获取数据库锁或改变源文件。
读取 480672845 字节，874051 条记录和 433217 个事务均通过 CRC32C/提交标记核验，
无未提交尾记录；扫描前后 inode、大小、mtime 相同。这是历史 value-log 审查，不是
运行中整个数据库的原生一致性快照。

A/B/C 最新发布事务分别为 427547、428677、430127；均 succeeded、server_status=visible、
发布 attempts=1、LastError 空，资产身份和大小与 D1 一致。三条原事件链共 20 个事件的
本地保留字段与 D1 逐字段相同；没有以发布 attempts 冒充下载尝试次数。当前发布状态为
succeeded 2422、failed 8，无 pending；八项失败为保留的旧历史。扫描时当前轮待发事件为
零、next_sequence=50，没有清理 outbox 或修改失败记录。

08:15 从 Mac 与 NAS 分别重验 A/B/C，以及巡检原选定的最新 YouTube 26438240 字节和
Bilibili 1859370 字节，共五份媒体：

- 十份 RSS 均 200，每个原 enclosure 恰一条、length 等于 D1。
- 十次 Range 均为 206/1024 字节，Content-Range 总长等于 D1；双方前缀 SHA-256
  与物理源文件逐份相同，源大小正确，每个原 feed 目录中恰有一份同设备同 inode 的硬链接。
- 两侧 Worker `/health` 200/ok、媒体 `/healthz` 204、匿名 dashboard 302 至原
  Cloudflare Access；TLS 校验通过。

## 运行读回、验证与待办边界

08:26 独立读回仍是 11/17 12:21:40 启动的原 producer，会话、实际 arm64 二进制与
source manifest 均匹配登记源码 `6a66af4`；只有一个运行中的数据库消费者和应用 PID 1。
两个消费者均 healthy、RestartCount=0、无 OOM，登记 ID/指纹、冻结制品、配置和激活
哈希一致。恢复器 approved/ready，attempts、inspection/observation streak 为零，
历史 inspection 仍 56；该窗口控制失败为零。

Linux 原 lease 与完整 nonce ACK、boot、generation 相同，墙钟/BOOTTIME TTL 均为
固定十秒，采样剩余约 9.86 秒；两个实际 v2 gate 均通过，未绕过入口或制造租约。
源配置与 Cookie 的 SHA-256、mtime 和只读挂载在探针后保持原值。内部健康依据的
最近完整 feed 更新为 08:23:19，不能拿 discovery 时间替代媒体交付证明。

初次 D1 九条 SELECT 全部 `rows_written=0`；近 36 小时 35 轮序号唯一连续且从 1 起，
feed/download/upload/error 累计与事件计数一致。固定巡检窗口完整 feed 672，下载、上传、
上报各 20，终态下载错误 4，其余业务失败事件为零。最近完成轮为 06:25:45–07:26:44，
success、28 feed/1 下载/1 上传/0 错误；初次采样时 07:26:45 开始的新轮仍 running。

08:28 收尾五条 SELECT 仍全部 `rows_written=0`：该原轮已于 08:27:44 自然结束，
success、28 feed/0 下载/0 上传/0 错误；08:27:44 开始的下一轮为 running，事件序号 1，
不能计作完成。近 36 小时共 36 轮的序号与累计数继续匹配，固定窗口 feed 成功增至 700，
下载/上传/上报仍各 20，原四条终态下载失败没有增长；五份原媒体行完全相同。后续 3702
条日志仅两条旧 Bilibili 跳过 warning，无 error 或新增下载 summary；没有新下载，不能
据此认定当前 bot 限制已经解除。后续有界应用失败也仅为两个旧 Bilibili 样本，恢复器仍无新失败。

三个 Go 包 `pkg/ytdl`、`services/update`、`pkg/db` 检查通过，包含五份原失败输出回放、
期限/取消、输出分类、重试、终态事件及持久发布契约；临时测试源已从工作区移除，保留在
私有证据目录。它们验证应用行为，不能证明历史网络责任方或解除当前 bot 拒绝。
本次仓库只改文档，另检查链接、脱敏及 git diff，不需部署。

精确原身份、完整日志、只读 D1、CRC/事务扫描、发布/事件对账、提取及 client 对比、
双侧交付和运行读回位于 `runtime/private/podsync-followup-20261120/`，目录 0700、
文件 0600，附大小/SHA-256 清单。调查结果是原样本交付闭合、应用现有策略符合证据；
当前匿名提取仍受 bot 限制，媒体期限和 403 的底层触发原因仍未证明。
