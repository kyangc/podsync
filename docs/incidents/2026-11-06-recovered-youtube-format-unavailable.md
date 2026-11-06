# 2026-11-06：同一 YouTube 节目四轮格式不可用，随后自然发布

时间均为 Asia/Taipei（UTC+8）。本次跟进日常巡检新增的四条下载失败事件。
**四次均属于同一节目；原节目已自然恢复，双侧真实交付通过。没有发现需要代码、配置或运行修复的稳定缺陷。**
本次没有部署、重启、手工重跑同步、改变下载条件或清理失败历史。
已恢复与根因已证实分别判断；当时为何没有可匹配格式，仍受历史证据缺口限制。

## 原始失败与影响

| 最终下载失败 | 总耗时 / 进程耗时（ms） | 排队（ms） |
| --- | --- | --- |
| 11/5 23:12:56 | 7535 / 7534 | 0 |
| 11/6 00:11:24 | 7205 / 7205 | 0 |
| 11/6 01:11:08 | 7896 / 7895 | 0 |
| 11/6 02:10:52 | 7357 / 7355 | 0 |

四次 yt-dlp 终态输出均为 `Requested format is not available`。
每次均有同操作的两条 error 和一条 `episode download summary`，对应一条 D1
`episode_download_failed`、`error_code=download_failed`，不能将其计为十二次失败或四个节目。
摘要共同字段为 attempts 1、failed、downloader_error、last_stage extract、
metadata_available false、configured_player_client mweb、output_bytes 538、
output_truncated false、no_data_blocks false。

原始输出依次打印网页、mweb client config、mweb player API JSON、bgutil HTTP GVS
PO Token 请求、player 脚本和 Deno JS challenge 步骤，随后报格式不可用。
前三次打印同一 player 标识，第四次已打印另一个标识，仍然失败；不能把 player 标识变化
直接解释成修复。没有观察到 TLS/EOF、HTTP 403/429、媒体读取超时或明确 challenge/provider
失败提示；步骤日志也不证明对应响应及求解结果全部有效。
不能套用[昨日 TLS 超时](2026-11-05-recovered-youtube-tls-and-bilibili-api.md)的根因。

`extract` 是最后观察阶段，`metadata_available=false` 只表示下载摘要没有取得白名单格式字段，
不代表 discovery 或整个网站元数据不可用，也不能据此定位某次 HTTP 请求失败。
原节目在前四轮没有下载成功，从首次发现 23:12:49 至发布确认 03:14:51 约四小时两分钟，
存在实际交付延迟。

## 下载条件与原因边界

生产使用远端 feed 配置，不能只读宿主基础 TOML 后把默认 `bestaudio` 当成实际选择器。
接受的远端缓存与 [Worker 编译逻辑](../../cloudflare/worker/src/toml.ts)一致：

```text
18/best[protocol=https][vcodec!=none][acodec!=none]
```

远端 `--format` 追加在默认音频参数之后，覆盖 `bestaudio`，仍转为 MP3。
client 为 mweb，使用原 bgutil provider；socket timeout 12 秒、媒体/fragment retries 各 1，
feed 周期 1h、page_size 25。D1 中原 feed 的配置更新时间为 10/22 21:42:03。
当前缓存是最近一次接受的配置，不能代替四次历史调用的完整参数快照。

在原 Linux 容器的 yt-dlp 2026.10.26 上进行无网络的选择器检查，确认最后一个 `--format`
生效；format 18 和其他 HTTPS 音视频合流候选能匹配，单独音频、单独视频及 HLS 候选不能匹配。
检查只使用合成格式数据，没有下载媒体。这解释了规则的范围，不能证明失败时存在被排除的音频格式。
安装制品中的 `YoutubeDL.py` 在选择结果为空时产生上述错误；它不区分原始格式缺失、过滤后为空
或上游提取条件变化。

一次当前只读提取沿用接受的 feed 参数，追加 simulate、skip-download 和禁用磁盘 cache；
未传入 Cookie、未下载媒体、未改变调度。结果为 public、was_live，能够选择 HTTPS format 18，
音频为 mp4a.40.2、视频为 avc1；stderr 为空。自然成功摘要也已记录 format 18，见下文。

因此仍需区分以下候选原因：

1. 源端可用格式随回放处理时间变化；当前 was_live 支持考虑此方向，但没有失败时的处理状态。
2. 当时存在其他媒体格式，但无法匹配原选择器；失败时没有格式清单，不能确认。
3. mweb、播放器响应、challenge/session 或提取器兼容性变化；没有保存原始响应及求解结果。

原始失败的 player JSON、格式清单和 challenge 结果均未保存，成功下载也未保留完整提取输出。
因此无法重放原失败，当前成功提取不能复原当时条件，不能唯一认定为直播转码、YouTube 限制、
网络故障或选择器缺陷。没有据此扩大快速重试、切换 client/格式、轮换 Cookie 或强制升级。
[现有管理器](../../services/update/updater.go)对纯格式错误不执行额外快速重试，节目保留为
EpisodeError，按原调度重试；[已有测试](../../services/update/updater_test.go)明确覆盖这一边界。

## 自然恢复与任务闭合

| 原节目事件 | 时间 |
| --- | --- |
| 第五轮 discovered | 11/6 03:11:09 |
| 下载摘要 success | 03:12:03 |
| D1 download_finished | 03:12:04 |
| upload_finished / report_finished | 03:14:51 |
| 现有 episode 行 updated_at | 03:14:52 |

成功摘要为 attempts 1、总耗时 54290ms、进程 54289ms、排队 0、complete、
format_id 18、audio_codec mp4a.40.2、protocol https、metadata_available true、
output_bytes 13142、output_truncated false。现有 D1 状态 visible、媒体大小 27,475,244 字节。
原 feed 此后 03:12:04、04:10:59、05:11:02、06:10:58、07:10:49 完整更新成功。
最终读回还确认 08:11:24 自然完整更新成功，原节目成功链各一次、失败历史仍为四条。

本线程按原 feed/episode 身份读回整条事件链；从 11/5 22:00 起观察到的四个新节目，
各有下载、发布、上报成功，窗口内警告/错误仅为上述四条下载失败。八项 SELECT 均
`rows_written=0`，原失败保留，没有通过删除历史消警。
这证明已观察任务闭合，不能证明源端曾出现后又消失、从未被发现的节目没有遗漏。
该窗口不同于父巡检滚动 24 小时的 run/event 口径，不混用总数。

## 真实交付与生产验收

父巡检于 08:06–08:08 对本次原节目和最新样本完成 Mac/NAS 双侧验证，
大小分别为 27,475,244 / 26,223,261 字节：

- 四份 RSS 均 200，enclosure 各唯一，length 与 D1 一致。
- 四次媒体 Range 均 206、1024 字节，Content-Range 总长正确、TLS verify 为 0。
- 源文件大小与 D1 一致，每份恰有一个原下载文件同设备同 inode；双侧前 1024 字节 SHA-256
  均与 producer 对应源文件一致。
- 双侧 Worker 200/ok、media healthz 204，未认证 dashboard 302 至原 Access。

本线程 08:11:47 再读原节目源文件，大小仍为 27,475,244、同 inode 原文件恰为一份。
两个原消费者均 running/healthy、RestartCount 0、StartedAt 保持 11/4 08:09:47，
实际 ID、镜像与登记一致，登记 writer 为一，应用进程只有 PID 1。
恢复器 ready、attempts 0、两项 streak 0；实际双门禁均返回 0。
门禁探针仅保留原 Entrypoint 至 `--`，将全部业务命令替换为 `/bin/true`，未启动第二个应用。
Linux v2 租约 boot ID 一致、双时钟剩余约 9.734 秒，固定 TTL 均为十秒；
内部健康 healthy，最近完整 feed 更新为 08:11:30。
启动日志确认应用仍为 `9efb508`，控制器仍为 `79bbbe2`，原 ACK、TTL、期限和预算保持。

另观察到 08:09:52 自然自更新，08:09:54 正常返回 `yt-dlp is up to date`，版本仍为
2026.10.26；本线程未触发更新。这确认本次自然查询成功，不能据此宣称旧 GitHub 限流机制已根治。
没有新增控制失败也不能证明[11/4 底层 APFS 停顿](2026-11-04-guest-lease-io-stall.md)的触发者已定位。

原 ID 近 24 小时日志、后续增量、D1 读回、接受配置摘要、选择器检查、当前提取、
父巡检交付回执与生产读回保存在内置盘 `runtime/private/podsync-followup-20261106/`。
目录 0700、文件 0600，记录大小与 SHA-256；未打开运行中 Badger 的第二个实例。
本次仅新增事故记录，按文档变更规则检查 Markdown 链接、脱敏及 git diff；无需完整 Go 测试或部署。
