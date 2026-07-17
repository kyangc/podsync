# 远程控制面与 R2 发布设计

本文记录本 fork 后续要实现的远程管理能力设计。目标是把 Podsync 现有的 NAS 本地抓取流程扩展为“双轨发布”：本地订阅继续工作，同时新增 Cloudflare 控制面、R2 音频存储和远端 RSS/OPML。

## 目标

- 通过 Cloudflare 上的 dashboard 管理 feed 配置。
- Podsync 在 NAS 上运行时按 TTL 拉取远端 feed TOML，并与本地基础配置合并。
- NAS 继续本地抓取、转码、生成本地 XML/OPML，保持现有订阅源不受影响。
- NAS 将新下载的音频上传到 R2，并把 episode/feed metadata 回报给 Cloudflare。
- Cloudflare Worker 基于 D1 里的数据生成远端 RSS/OPML。
- 支持远端隐藏、删除、恢复 episode，并通过 tombstone 防止 NAS 重新发布已屏蔽内容。
- 上传关键事件日志，dashboard 能看到最近运行状态和错误。

## 非目标

第一版不做以下事情：

- 不迁移历史 episode，不批量上传已有本地 mp3。
- 不兼容旧 NAS RSS 的 GUID 或播放历史。
- 不做 feed_id rename。
- 不做 feed 硬删除；delete feed 采用保留 tombstone 证据的 soft delete。
- 不让 dashboard 管理 cookie 明文或 cookie 文件。
- 不开放任意 `youtube_dl_args`、headers、server/storage/tokens/R2 secret 编辑。
- 不把 Cloudflare Access 用在 podcast feed 或音频 URL 上。
- 不引入 KV/Queues；第一版只用 Worker、D1、R2、Access、Cron Trigger。

## 总体架构

```text
Cloudflare Worker
  - dashboard 静态页面
  - admin API
  - NAS API
  - RSS/OPML 渲染
  - scheduled cleanup/purge

D1
  - feed 配置
  - episode metadata
  - episode 状态
  - tombstone / 删除状态
  - sync run 摘要
  - 关键事件日志

R2
  - 音频文件
  - 原始错误日志，大日志可选

NAS Podsync
  - 拉远端 feed TOML
  - 与本地基础配置合并
  - 抓取/下载/转码
  - 保持本地 XML/OPML 输出
  - 上传新音频到 R2
  - upsert episode/feed metadata
  - 拉 tombstones 并防止重新发布
  - 批量上传关键事件
```

NAS 不暴露管理 API 到公网，只主动访问 Cloudflare。

## 双轨发布

第一版必须保留现有 NAS 本地发布链路：

```text
NAS 本地 mp3
NAS 本地 feed XML
NAS 本地 OPML
现有 podcast 订阅 URL
```

远端链路是新增能力：

```text
R2 mp3
D1 episode metadata
Worker RSS
Worker OPML
dashboard 生成的订阅 URL
```

CF 版 feed 初始可以为空。只发布 remote 功能启用后新下载成功的 episode，不扫描历史 `downloaded` episode。

## 本地配置与远端配置

本地 `config.toml` 继续保存运行时和敏感配置：

```toml
[server]

[storage]

[tokens]

[remote]
enabled = true
base_url = "https://podcast.example.com"
token = "..."
cache_path = "/app/data/remote/config.last-success.toml"
config_refresh_interval = "5m"

[r2]
endpoint = "https://<accountid>.r2.cloudflarestorage.com"
bucket = "podcasts"
prefix = "audio"
access_key_id = "..."
secret_access_key = "..."

[cookie_profiles.bilibili-main]
provider = "bilibili"
path = "/app/secrets/cookies/bilibili-main.txt"
readonly = true
```

远端 API 暴露稳定的 TOML artifact：

```text
GET /api/nas/config.toml
```

远端 TOML 只包含 feed 相关配置。Cloudflare 内部可以用结构化 D1 表维护配置，但 NAS 正式消费协议是 TOML。

示例：

```toml
[feeds.tangpingshu]
url = "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw"
format = "audio"
quality = "high"
page_size = 25
update_period = "1h"
opml = true
private_feed = true
clean = { keep_last = 25 }
filters = { not_title = "直播" }
youtube_dl_args = ["--socket-timeout", "12", "--retries", "1", "--fragment-retries", "1"]
```

### 合并规则

```text
remote.enabled = false:
  final feeds = local feeds

remote.enabled = true:
  if remote fetch + validation success:
    final feeds = remote feeds
    update cache
  else if remote cache valid:
    final feeds = cached remote feeds
  else if local feeds exist:
    final feeds = local feeds
    emit warning
  else:
    skip update cycle
    emit error
```

remote 模式打开后，远端 feeds 是权威。本地 `[feeds.*]` 只做 emergency fallback。

### 主程序接入约束

远端配置不能简单在 `LoadConfig()` 之后覆盖 `cfg.Feeds`。当前本地配置加载会立即执行 defaults/env/validation，且 validation 要求至少一个 feed；remote 模式下可能本地没有 feed，但远端配置有效。因此实现时需要把配置流程拆成：

```text
1. 读取本地 runtime/sensitive config
2. 如果 remote.enabled=false，走现有本地配置流程
3. 如果 remote.enabled=true，先 resolve final feeds
4. 对 final feeds 应用 defaults/cleanup/env/validation
5. 再创建 key providers、updater、scheduler
```

调度层也不能只在启动时注册一次 cron。remote feeds 是权威后，新增 feed、disable feed、修改 `update_period` 都需要 feed-set reconcile：

```text
remote snapshot 变化
-> diff 当前 cron entries
-> add new feed schedules
-> remove disabled/deleted feed schedules
-> update changed schedules without duplicate registration
-> updater/OPML 使用同一份当前 feed map
```

如果暂时不能安全 reconcile，相关阶段不得声称 remote config 已完整支持动态生效。

## 远端配置刷新

- 按 TTL 刷新，默认 `config_refresh_interval = "5m"`。
- 每次刷新 config 时顺带拉 tombstones。
- 远端 TOML 无效时不应用新配置，继续使用上次成功 cache。
- dashboard 配置错误不应打断已经稳定运行的旧 cache。

## Feed 管理范围

第一版 dashboard 支持这些字段：

```text
feed_id              创建后不可改
provider             youtube | bilibili
url
title_override
description_override
enabled
include_in_opml
private_feed
update_period
page_size
keep_last
cookie_profile
filters
```

`feed_id` 是系统身份，不是展示字段。它参与 tombstone 匹配、R2 key、RSS URL、episode identity、本地目录和本地 XML 文件名。第一版不允许改名。

远端 feed 必须显式维护 `provider`。即使最终 TOML 暂时不输出该字段，D1/dashboard 内部也要保存。

## Downloader 参数

当前 live 配置里只有 13 个 YouTube feed 使用同一组 `youtube_dl_args`：

```toml
youtube_dl_args = ["--socket-timeout", "12", "--retries", "1", "--fragment-retries", "1"]
```

第一版不开放任意 `youtube_dl_args` 文本编辑，只提供全局 YouTube downloader defaults：

```text
socket_timeout = 12
retries = 1
fragment_retries = 1
```

Cloudflare 生成 TOML 时把它们编译成 `youtube_dl_args`。

Bilibili 第一版只管理 `cookie_profile`。常用 Bilibili headers 由 Podsync 代码内置，不从远端配置 headers。

## Cookie 策略

Cookie 只放 NAS 本地，dashboard 不管理 cookie 内容。

远端 feed 只引用 profile：

```toml
cookie_profile = "bilibili-main"
```

本地 TOML 显式维护 profile 到文件路径的映射：

```toml
[cookie_profiles.bilibili-main]
provider = "bilibili"
path = "/app/secrets/cookies/bilibili-main.txt"
readonly = true
```

运行规则：

- 找不到 profile：该 feed 标记配置错误并上报 `cookie_profile_missing`。
- downloader 使用 cookie 前复制到临时文件。
- downloader 只读临时副本。
- 下载结束删除临时副本。
- 原始 cookie 文件不被回写，避免污染。
- 日志和事件不上传 cookie、token、headers 明文。

## Episode identity 与 tombstone

当前 Podsync 本地 episode ID 事实：

- YouTube：`episode.ID = video id`
- Bilibili：`episode.ID = bvid`
- 当前 RSS GUID 直接使用 `episode.ID`

远端数据库可以有自己的 episode row id，但 NAS 不使用远端 row id 做匹配。跨端稳定匹配键是：

```text
feed_id + local_episode_id
```

NAS upsert episode 时必须上报：

```json
{
  "feed_id": "tangpingshu",
  "provider": "youtube",
  "source_episode_id": "sxzZ-B6nfw4",
  "local_episode_id": "sxzZ-B6nfw4"
}
```

Bilibili 示例：

```json
{
  "feed_id": "zhongqiai",
  "provider": "bilibili",
  "source_episode_id": "BV1TZTy6oE3w",
  "local_episode_id": "BV1TZTy6oE3w"
}
```

Tombstone 下发也必须带 `feed_id + local_episode_id`。第一版 tombstone 只影响 CF 发布面，不删除 NAS 本地 mp3/XML/OPML。

## Episode 远端状态

第一版使用 5 个状态：

```text
pending
visible
hidden
delete_pending
purged
```

语义：

- `pending`：已发现或正在发布，但音频/metadata 未完整完成，不进入 RSS。
- `visible`：进入 Worker RSS。
- `hidden`：手动隐藏，不进入 RSS，R2 object 保留。
- `delete_pending`：手动删除，不进入 RSS，R2 object 等待延迟 purge。
- `purged`：R2 object 已硬删，不进入 RSS。

状态转换：

```text
R2 uploaded + episode upsert -> visible
dashboard hide -> hidden
dashboard delete -> delete_pending
scheduled purge -> purged
restore hidden/delete_pending -> visible
```

第一版 restore 只支持 `hidden` 和 `delete_pending`。`purged` 不支持恢复。

### Upsert 状态保护

NAS 的 `episodes/upsert` 只能创建 episode、补充 metadata、补充 R2 asset 信息，不能覆盖 dashboard 人工状态。

状态矩阵：

```text
episode 不存在:
  create status=visible

episode.status = pending:
  update metadata/asset
  set status=visible if asset verified

episode.status = visible:
  update metadata/asset
  keep status=visible

episode.status = hidden:
  update metadata/asset if useful
  keep status=hidden

episode.status = delete_pending:
  keep status=delete_pending
  do not make visible

episode.status = purged:
  keep status=purged
  do not make visible
```

也就是说，NAS 重试 upsert 不得把 `hidden`、`delete_pending` 或 `purged` 重新发布成 `visible`。API response 应返回当前 server-side status，让 NAS 可以停止或调整对应 outbox task。

## Feed disable 与 delete

Disable feed：

- `enabled=false` 时不下发给 NAS，不再抓新集。
- `include_in_opml=false` 时不进入 CF OPML。
- 已有远端 episode 不动。
- feed XML 可以继续访问，只是不再更新。
- NAS 本地内容不动。

Delete feed 使用 soft delete，不硬删 `feeds` / `episodes` / `tombstone_changes`：

- 批量 episode 进入 `delete_pending`。
- OPML / NAS TOML / admin feed 列表移除。
- 旧 feed token 返回 410。
- R2 延迟 purge。
- tombstone 下发给 NAS，防止重新发布。
- 保留 D1 里的 feed/episode/tombstone 记录，保证 `cursor=0` tombstone 快照不会漏删。

## R2 发布

### 发布顺序

```text
1. 本地下载/转码成功
2. 本地 episode 标记 downloaded
3. 本地 XML/OPML 正常更新
4. 生成或复用 r2_key
5. 上传音频到 R2
6. HEAD R2 object，确认 Content-Length 等于本地文件大小
7. upsert episode visible
8. Worker RSS 才展示该 episode
```

R2 上传或 episode upsert 失败不影响本地发布。失败任务进入 remote outbox，下轮重试。

### R2 object key

音频 key 使用可读前缀加随机 token：

```text
audio/<feed_id>/<local_episode_id>-<asset_token>.mp3
```

示例：

```text
audio/tangpingshu/sxzZ-B6nfw4-k8f3n2p9q4.mp3
audio/zhongqiai/BV1TZTy6oE3w-p7x2m8v1c9.mp3
```

NAS 只上报：

```json
{
  "r2_key": "audio/tangpingshu/sxzZ-B6nfw4-k8f3n2p9q4.mp3",
  "size": 12345678,
  "mime_type": "audio/mpeg"
}
```

Worker 根据自己的 `MEDIA_PUBLIC_BASE_URL` 动态生成 enclosure URL。NAS 不保存公开媒体域名。

### R2 权限

NAS 本地 R2 token 尽量最小权限：

- 允许 PutObject。
- 允许 HeadObject/读取对象 metadata。
- 不负责 DeleteObject。
- 不需要 ListBucket。

R2 删除/purge 由 Worker 通过 R2 binding 执行。

### 删除与恢复

Dashboard 删除 episode：

```text
D1 status = delete_pending
Worker RSS 立即隐藏
R2 object 保留 7 天
```

Cron purge：

```text
delete_pending 且 purge_after <= now
-> 删除 R2 object
-> status = purged
```

7 天内可以 restore 到 `visible`。

restore 和 purge 都必须使用条件更新，避免竞态：

```text
restore delete_pending:
  HEAD R2 object 成功
  AND current status still delete_pending
  -> status=visible

purge:
  current status still delete_pending
  AND purge_after <= now
  AND R2 delete success
  -> status=purged
```

如果 R2 delete 失败，不得把状态改成 `purged`。

## Outbox 与重试

远端发布和事件上传使用本地 outbox，不阻塞本地主流程。

第一优先实现 DB-backed outbox，因为当前 Badger 已经是本地 durable state，适合保存 `feed_id + local_episode_id` 去重、attempt count、next retry、r2_key、tombstone cursor 等状态。

文件 outbox 仍可用于 config cache、raw logs 或临时批量事件，但写入必须使用 atomic rename，且不能放到会被本地 Web/S3 media storage 语义影响的位置。

建议本地路径：

```text
data/remote/outbox/
data/remote/outbox/sent/
data/remote/config.last-success.toml
```

R2 上传与 upsert 重试策略：

```text
前 3 次：每轮重试
第 4 次起：指数退避
最大退避：24h
```

永久失败条件第一版只做少量：

- 本地文件不存在。
- episode 已 tombstoned。

R2 鉴权失败等仍视为 retryable，但 dashboard 标红，需要人工处理。

R2 上传第一版串行执行，不做并发上传。

## RSS 与 OPML

### Public URL 鉴权

Podcast 客户端使用长随机 path token：

```text
/f/<feed_token>.xml
/opml/<opml_token>.xml
```

不使用 Cloudflare Access、header auth 或 HTTP Basic。

音频 URL 使用不可猜 R2 key，不依赖 query token。

### OPML 规则

第一版 OPML 只包含 active feed：

```text
enabled = true AND include_in_opml = true
```

### 空 feed

空 feed 返回：

```text
HTTP 200
合法 RSS XML
channel metadata 完整
items = []
```

不要返回 404，否则 podcast app 可能认为订阅无效。

### Channel metadata

Worker 生成 RSS channel metadata 使用混合策略：

```text
dashboard override > NAS reported metadata > feed_id/url fallback
```

NAS 每轮 feed update 成功后 upsert feed metadata：

```json
{
  "feed_id": "tangpingshu",
  "provider": "youtube",
  "source_url": "...",
  "title": "...",
  "description": "...",
  "image_url": "...",
  "last_source_update_at": "...",
  "reported_at": "..."
}
```

feed update 失败时只上传事件，不覆盖旧 metadata。

## API 草案

路径由代码约定，本地只配置 `base_url`。

```http
GET /api/nas/config.toml
Authorization: Bearer <NAS_TOKEN>
```

返回远端 feed TOML。

```http
GET /api/nas/tombstones?cursor=<cursor>
Authorization: Bearer <NAS_TOKEN>
```

返回自 cursor 后的 tombstone/visibility 变化。

响应格式：

```json
{
  "cursor": 123,
  "next_cursor": 130,
  "has_more": false,
  "changes": [
    {
      "sequence": 124,
      "feed_id": "tangpingshu",
      "local_episode_id": "sxzZ-B6nfw4",
      "status": "hidden",
      "action": "hide",
      "created_at": "2026-07-06T10:00:00Z"
    }
  ]
}
```

协议要求：

- `sequence` 单调递增。
- 返回按 `sequence ASC` 排序。
- NAS 只有成功应用并持久化后才能推进本地 cursor。
- `cursor=0` 返回当前所有 tombstoned episode 的快照，也就是 `hidden`、`delete_pending`、`purged`，作为首次同步或 cursor 丢失兜底。`pending` 是发布流程状态，不作为 tombstone 下发。
- 如果服务端未来设置 tombstone change 保留期，必须提供快照兜底，不能让 NAS 漏删。

```http
POST /api/nas/episodes/upsert
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

幂等写入 episode metadata。唯一键：

```text
feed_id + local_episode_id
```

该接口必须遵守 upsert 状态保护，不能把 dashboard 人工隐藏/删除的 episode 重新置为 `visible`。

```http
POST /api/nas/feed-metadata/upsert
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

幂等写入 feed metadata。

```http
POST /api/nas/events/batch
Authorization: Bearer <NAS_TOKEN>
Content-Type: application/json
```

批量写入关键事件。

事件写入必须幂等。第一版使用：

```text
unique(run_id, sequence)
```

NAS outbox 重试同一个 batch 时，服务端不得重复计数。

```http
GET /f/<feed_token>.xml
GET /opml/<opml_token>.xml
```

公开 podcast 订阅入口。

## 鉴权

- Dashboard 和 Admin API：使用 Cloudflare Access。Worker 会验证 `Cf-Access-Jwt-Assertion` 的 RS256 签名、issuer、audience 和过期时间；仅有同名 header 不视为已登录。
- 旧 `ADMIN_TOKEN` bearer、cookie 和 `?token=` 登录均不再支持；已通过 Access 的旧链接只会移除 `token` query，再跳转到干净 URL。
- NAS API：单个全局 `NAS_TOKEN`，通过 `Authorization: Bearer`。
- Public RSS/OPML：长随机 path token。
- R2 audio：不可猜 object key + 公开媒体域名。

Worker 的 Access 配置：

```text
ACCESS_ISSUER=https://<team-name>.cloudflareaccess.com
ACCESS_AUD=<Application Audience AUD Tag>
```

Cloudflare Zero Trust 中只为网页管理面创建 self-hosted Access application，使用 One-time PIN 和完整邮箱 allowlist。应用 destinations：

```text
podsync.kyangc.net/dashboard
podsync.kyangc.net/dashboard/*
podsync.kyangc.net/api/admin
podsync.kyangc.net/api/admin/*
```

不要为 `podsync.kyangc.net/*` 创建整站 Access 规则。

路由边界：

```text
/dashboard*
/api/admin/*
  -> verified Cloudflare Access JWT

/api/nas/*
  -> Bearer NAS_TOKEN

/f/<feed_token>.xml
/opml/<opml_token>.xml
  -> path token only, no Access

/media or R2 custom domain
  -> public object URL with unguessable key
```

Cloudflare Access 规则不能覆盖 NAS API、public RSS/OPML、`/health` 或 R2 媒体地址，否则非浏览器客户端会被登录流程阻断。`workers.dev` 和 preview URL 不会经过自定义域名的 Access application，因此无法生成通过 Worker 验证的 Access JWT。

上线验收：

1. 验证 One-time PIN 登录后 dashboard 和 Admin API 正常。
2. 验证 NAS 配置拉取、RSS、OPML、`/health` 和媒体地址保持正常。
3. 确认 Worker secrets 中只有 `NAS_TOKEN`，旧 bearer、cookie 和 `?token=` 不再授权。

## 关键事件日志

事件日志只上传关键事件，不上传普通下载进度和大段 stdout/stderr。

第一版事件白名单：

Run 级别：

```text
sync_run_started
sync_run_finished
remote_config_fetched
remote_config_fallback_used
remote_config_invalid
```

Feed 级别：

```text
feed_update_started
feed_update_finished
feed_update_failed
```

Episode 级别：

```text
episode_discovered
episode_download_finished
episode_download_failed
episode_upload_finished
episode_upload_failed
episode_report_finished
episode_report_failed
```

Tombstone / 管理动作：

```text
tombstone_fetched
tombstone_applied
tombstone_apply_failed
```

系统级：

```text
r2_probe_failed
remote_api_failed
cookie_profile_missing
cookie_profile_invalid
```

不上传：

- yt-dlp 下载进度。
- 每个已下载 episode 的 skip 日志。
- 正常 XML/OPML 写文件日志。
- cookie、token、headers 明文。
- 大段 stdout/stderr。

事件和业务状态分离：

```text
events = 过程日志
episodes = 业务状态
```

episode metadata 使用独立 upsert API，不塞进事件表。

## 日志保留

```text
events 明细：30 天
sync_runs 摘要：180 天
feed_latest_status：长期保留
episode_publish_status：跟 episode 生命周期走
R2 raw error logs：90 天
```

Cron Trigger 负责清理过期事件、sync runs、raw logs，并执行 R2 purge。

## Cloudflare 数据模型草案

第一版 D1 表可以按以下概念设计，字段名实现时再细化：

```text
feeds
  id
  feed_id
  provider
  url
  title_override
  description_override
  enabled
  include_in_opml
  private_feed
  update_period
  page_size
  keep_last
  cookie_profile
  feed_token
  created_at
  updated_at

feed_filters
  feed_id
  title
  not_title
  description
  not_description
  min_duration
  max_duration
  min_age
  max_age

global_downloader_defaults
  provider
  socket_timeout
  retries
  fragment_retries

feed_metadata
  feed_id
  provider
  source_url
  title
  description
  image_url
  last_source_update_at
  reported_at

episodes
  id
  feed_id
  provider
  source_episode_id
  local_episode_id
  source_url
  thumbnail
  title
  description
  published_at
  duration
  status
  r2_key
  size
  mime_type
  asset_token
  deleted_at
  purge_after
  created_at
  updated_at

tombstone_changes
  id
  sequence
  feed_id
  local_episode_id
  status
  action
  created_at

sync_runs
  id
  started_at
  finished_at
  status
  feeds_updated
  episodes_downloaded
  episodes_uploaded
  errors_count

events
  id
  run_id
  sequence
  event_time
  level
  type
  feed_id
  local_episode_id
  message
  error_code
  error_detail
```

需要的唯一约束和索引：

```text
feeds.feed_id UNIQUE
feeds.feed_token_hash UNIQUE
opml_tokens.token_hash UNIQUE
episodes(feed_id, local_episode_id) UNIQUE
tombstone_changes(sequence) UNIQUE
events(run_id, sequence) UNIQUE
```

Feed/RSS metadata 后续还需要覆盖现有 `pkg/feed/xml.go` 的关键字段，例如 `link`、`author`、`category`、`subcategories`、`language`、`explicit`、`ownerName`、`ownerEmail`。第一版可以先做最小字段，但 RSS golden tests 必须证明空 feed 和 visible episode feed 对常用 podcast 客户端是合法的。

## 实施分期

### Phase 0：本地模式回归夹具

- 建立 remote disabled 的回归测试。
- 证明无 `[remote]` 或 `remote.enabled=false` 时不发 HTTP、不初始化 R2/outbox、不改变本地 feed map、XML、OPML、health 行为。

### Phase 1A：Cloudflare Worker 骨架

- 新建 Worker 目录。
- D1 schema/migrations。
- Worker API skeleton。
- dashboard 静态壳。
- 不改 Podsync 主流程。

### Phase 1B：NAS/Public contract

- `/api/nas/config.toml` Bearer 鉴权和 TOML 编译。
- 空 RSS/OPML 合法输出。
- Public path token 和 admin Access 路由边界。

### Phase 2A：Go 配置结构

- 本地 `[remote]` 配置块。
- 本地 `[r2]`、`[cookie_profiles]` 配置块。
- `remote.enabled=false` 保持现状。

### Phase 2B：Remote config resolver

- 拉 `/api/nas/config.toml`。
- TTL/cache/fallback。
- remote feeds 权威合并。
- invalid TOML 不覆盖 last-success cache。

### Phase 2C：调度接入

- 抽出 feed scheduler/reconcile seam。
- 支持新增、禁用、更新 schedule。
- updater 和 OPML 使用同一份当前 feed map。

### Phase 3A：Outbox + publish hook

- 下载成功后 enqueue remote publish task。
- 不扫描历史 downloaded episode。
- remote publish 失败不影响本地 XML/OPML。

### Phase 3B：R2 client + retry

- 独立 R2 publisher，不复用主 `fs.Storage`。
- Put/Head only。
- 串行上传、size 校验、混合重试。

### Phase 3C：Upsert + Worker RSS

- upsert episode visible。
- upsert 状态保护。
- Worker RSS 生成。

### Phase 4：dashboard 管理

- feed 管理。
- 订阅 URL/OPML URL。
- episode 列表。
- hide/delete/restore。
- tombstone 拉取与应用。

### Phase 5：日志和状态面板

- events batch。
- sync_runs/feed latest status。
- retention cron。
- raw error logs 可选。

## 仍需实现时确认

- 当前 Podsync 调度循环的最佳 remote config 刷新接入点。
- 本地 DB 是否适合直接扩展 remote publish status，或先用文件 outbox。
- R2 S3 client 应作为独立 remote publisher 实现，不替代现有 `pkg/fs.Storage` 主存储。
- Bilibili 内置 headers 应落在 ytdl 调用层还是 provider 层。
- Worker RSS XML 的 itunes 字段需要与现有 `pkg/feed/xml.go` 输出尽量对齐。
