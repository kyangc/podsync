# 2026-11-09：Bilibili API 告警自然恢复复核

时间均为 Asia/Taipei（UTC+8）。**本次新增的一条 Bilibili feed 失败已自然恢复，
原 feed 连续七轮完整更新成功，现有内容真实交付通过。未发现足以支持代码、配置或运行
修复的稳定缺陷。** 本次仅记录证据，没有部署、重启、手工重跑同步、改变 Cookie 或重试预算。
恢复结论不等于供应商内部根因已经证实。

## 原始失败与请求边界

11/9 00:13:05，原用户空间 feed 的 stdout 和 D1 均记录
`bilibili api error: 服务调用超时`。D1 为一条 `feed_update_failed`，没有 episode ID。
原 `bilibili_discovery` 诊断为：

| 字段 | 原值 |
| --- | --- |
| HTTP / provider code | 200 / -504 |
| error kind / elapsed | application / 276ms |
| client limit / context state | 10000ms / none |
| context budget | -1 |
| stage / first byte / body read | body_read / 275ms / 0ms |
| body bytes / EOF / close failed | 113 / true / false |
| reused / connection acquisitions / trace ambiguous | true / 1 / false |
| request written / response headers | true / true |
| dropped / write failures | 0 / 0 |

因此可确认这是完整 HTTP 响应中的供应商业务错误，不能解释成本地十秒期限耗尽或 TLS 超时。
[API client](../../pkg/builder/bilibili_api.go)在 `context.Background()` 上开始观察，
`budget_ms=-1` 表示此处没有 context deadline；另有 `http.Client.Timeout=10s`，
且原记录直接保存了 `client_limit_ms=10000`，不能将 -1 解释为没有请求超时保护。
Cookie jar 复制沿用该 client 的限制。诊断不保存 endpoint、请求标识或完整响应，
不能进一步确定具体 API 路径或供应商内部哪一层超时，也无法可靠重放原服务条件。

[Builder](../../pkg/builder/bilibili.go)仅跳过已明确不可用的 -404；其他 API 错误返回给
[更新器](../../services/update/updater.go)。此次 Build 失败发生在本轮 `AddFeed` 之前，
外层尚未进入下载、清理与 XML/OPML 发布。不能将这条事件称为某个节目下载失败。
原记录保留，调度器继续其他 feed；本轮没有新增应用层快速重试。

同类 -504 在[11/5](2026-11-05-recovered-youtube-tls-and-bilibili-api.md)和
[11/7](2026-11-07-recovered-bilibili-and-youtube-format-alerts.md)也曾被复核，均于下一轮恢复。
重复出现相同业务码尚不足以证明共同的底层原因，亦没有支持更换 Cookie、client 或扩大
快速重试预算的证据。

## 同一 feed 的自然恢复与影响

原 feed 01:12:15 自然开始下一轮，01:12:17 完整更新成功，距原失败约 59 分钟。
本线程按原 feed 身份逐条读回的后续 `feed_update_finished` 为：
01:12:17、02:12:13、03:12:28、04:12:45、05:12:28、06:12:49、07:12:14。
失败后没有该 feed 的后续错误。

该次失败推迟了本轮源内容查询。下一轮成功不能证明失败窗口内曾出现又消失、从未被
观察到的内容没有遗漏；本次没有补造或重放未知任务。
原 feed 的交付样本为 3,313,786 字节，D1 更新时间为 11/8 22:15:39，早于原失败。
它证明现有内容当前可交付，不能称为失败后新发现、下载或发布的恢复样本。

六条关联 D1 SELECT 均成功、`rows_written=0`：

- 从 11/9 00:00 起，warn/error 仅上述一条 feed 失败；窗口内观察到的四个节目各有一次
  下载、发布和上报成功，关联错误为零。该固定事件窗口不与父巡检滚动 24 小时总量混用。
- 从 11/8 08:00 起的 23 轮，事件序号从 1 至 count 唯一连续，feed/download/upload/error
  计数与事件一致。
- 最近完成轮为 06:30:37–07:31:36，success、28 feed / 1 download / 1 upload / 0 error。
  当前轮自 07:31:36 正常 running，08:00:37 已有新事件；当时 31 条事件、业务计数为零，
  不能据 running 或零计数判定卡死。

## 真实交付与当前生产验收

08:04，本线程独立复核最新两个样本与原 feed 旧样本，大小分别为
27,206,490 / 11,685,084 / 3,313,786 字节，与父巡检 08:00–08:01 的结果一致：

- Mac/NAS 六份 RSS 均 200，enclosure 各唯一，length 与 D1 相同。
- 六次 Range 均 206、1024 字节，Content-Range 总长正确，TLS 校验通过。
- 源文件大小与 D1 一致，每份恰有一个原下载文件同设备、同 inode；双侧前 1024 字节
  SHA-256 均与 producer `/app/data/.remote-media` 源文件一致。
- 双侧 Worker 200/ok、media healthz 204，未认证 dashboard 302 至原 Access。

08:03 实际运行读回：两个原登记消费者均 healthy、RestartCount 0，StartedAt 仍为
11/8 09:10:32/33，ID 与配置指纹匹配；登记 writer 一，数据库 volume 的运行消费者仅
producer，实际应用进程仅 PID 1。原控制器仍唯一、ready_since 仍为昨日 09:10:33，
自动 attempts 零、两个 streak 零、inspection 历史 56。

双实际门禁均返回 0；探针仅保留原 Entrypoint/Cmd 到 `--`，其后业务命令全部替换为
`/bin/true`。Linux v2 lease 的完整 nonce ACK JSON 与租约相同，boot ID、generation
与当前会话一致；固定双时钟 TTL 均十秒，剩余各约 8.786 秒。
内部 health healthy，实例最近完整更新为 07:13:40；该实例指标不冒充原 feed 专属时间。
实际应用二进制与 source manifest 哈希符合部署登记 `9efb508`，镜像为 arm64，冻结控制
制品哈希全部匹配；源配置/Cookie 的 SHA、mtime 与只读挂载保持。
昨日 09:34 验收后的现存宿主诊断未见新控制失败；原完整 ACK、TTL、两秒发布预算及
SSH/观察期限不变。这不能证明既有底层停顿或首个媒体 probe 的未知触发者已根治。

原 ID 日志查询范围为 11/8 08:02:30–11/9 08:02:30，读回 80,273 行，首条
11/8 09:10:33、末条 11/9 08:01:55；完整 feed 成功 643，fatal/panic 零。
查询起点至昨日恢复之间属于[已记录的保护性停机](2026-11-08-host-dependency-recovery.md)，
不能把启动后日志当作整 24 小时持续运行。另有昨日启动时自更新 GitHub 403 的两条旧 error，
及两个既有 Bilibili 不可用样本的 46 条跳过记录，均未混算为今日新故障；没有手工触发自更新。
应用 failure 分段仅 46 条 -404 和本次一条 -504，没有其他内部远端失败。

## 留证与验证

原日志、失败上下文、诊断、D1、运行读回、双侧交付和源文件核对保存在内置盘
`runtime/private/podsync-followup-20261109/`，目录 0700、文件 0600；清单记录文件大小和
SHA-256。没有打开运行中 Badger 的第二个实例，也没有修改任务、历史或预算。

现有 provider 业务错误分类、非 -404 错误返回、Cookie 域匹配及 HTTP 正文错误保留的
定向 Go 测试通过。它们验证本地处理边界，不能重现供应商内部超时。
本次仅新增事故文档，检查本地 Markdown 链接、脱敏与 git diff；无需完整 Go 测试或部署。
