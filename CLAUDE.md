# CLAUDE.md

这份文档给 Claude Code / Codex 等代码助手使用，用来快速理解本仓库的工程结构、运行行为和维护边界。

## 项目概览

Podsync 是一个 Go 服务，用来把 YouTube、Vimeo、SoundCloud、Twitch 和 Bilibili 的频道、用户、播放列表或空间内容转换成 podcast feed。它会发现节目、下载音视频文件，并生成可被 podcast 客户端订阅的 RSS。

## 本 Fork 的维护边界

本仓库以 upstream `mxpv/podsync` 的 `main` 分支为基底，目标是尽量保持 upstream 新能力，同时维护 Bilibili 转 podcast 的能力。`yangtfu/podsync` 是 Bilibili 能力的重要参考，但当前实现已经重新落在新版 Podsync 的 builder、model、update、ytdl 等结构上。

本 fork 的主要差异：

- 新增 Bilibili provider。
- 支持 Bilibili 用户空间：`https://space.bilibili.com/<mid>`。
- 支持 Bilibili 空间列表：`/lists/<id>?type=season` 和 `/lists/<id>?type=series`。
- 支持可选包含“充电专属”视频：`bilibili.include_upower_exclusive = true`。
- 支持 `bilibili.cookies_file`，用于 Bilibili API 请求和 `yt-dlp` 下载。
- Bilibili 下载时会自动追加常见 headers：`Referer`、`Origin`、`Accept-Language`。
- Bilibili cookies 会在下载前复制到临时目录，再传给 `yt-dlp`，避免源 cookies 文件被回写污染。
- Bilibili 不要求官方 API token，并且会跳过旧配置里的空 `bilibili` token。
- 新增 `filename_template`，用于控制下载文件名和 RSS enclosure 路径。
- 新增 `--migrate-filenames` 和 `--migrate-filenames-dry-run`，用于一次性迁移已下载文件名。
- GitHub Actions 已切到 `kyangc/podsync`：`main` 发布 `ghcr.io/kyangc/podsync:nightly`，`v*` tag 发布正式镜像和 release。

Go module 路径仍保留 `github.com/mxpv/podsync`，这是为了降低与 upstream 的差异。不要为了“看起来更像 fork”随意改 module path。

## 关键目录

### 主程序：`cmd/podsync/`

- `main.go`：CLI 参数、信号处理、服务编排。
- `config.go`：TOML 配置加载、默认值和校验。

### 核心包：`pkg/`

- `builder/`：各平台 feed discovery，包括 YouTube、Vimeo、SoundCloud、Twitch、Bilibili。
- `feed/`：RSS/podcast feed 生成、OPML、hooks、API key 轮换、feed 配置结构。
- `db/`：基于 BadgerDB 的元数据和状态存储。
- `fs/`：存储抽象，支持本地文件系统和 S3 兼容存储。
- `model/`：核心数据结构和领域模型。
- `ytdl/`：`youtube-dl` / `yt-dlp` 下载封装。

### 服务：`services/`

- `update/`：feed 更新编排、调度、节目过滤。
- `web/`：HTTP 服务，提供 RSS、媒体文件、健康检查等。
- `migrate/`：文件名迁移工具，用于把已有文件迁移到新的 `filename_template`。

## 节目生命周期

### 发现阶段

- feed 更新时通过平台 API 发现节目。
- `services/update/updater.go` 中的 `updateFeed()` 会调用对应 builder。
- 新节目写入 BadgerDB，初始状态为 `EpisodeNew`。
- URL 解析和平台识别主要在 `pkg/builder/url.go`。

### 下载阶段

- `fetchEpisodes()` 会处理 `EpisodeNew` 和 `EpisodeError` 状态的节目。
- 过滤逻辑在 `services/update/matcher.go`，支持标题、描述、时长、发布时间过滤。
- 每次更新最多排队 `page_size` 期节目，默认 50。
- 下载先写入临时目录，成功后再复制到目标存储，避免留下不完整文件。
- 成功后状态变成 `EpisodeDownloaded`，并记录文件大小。
- 失败后状态变成 `EpisodeError`，下一轮更新会重试。

### 清理阶段

- `cleanup()` 在成功更新后运行。
- 只有配置了 `clean.keep_last` 时才会清理。
- 清理按 PubDate 倒序保留最近 N 期。
- 被清理的节目状态变成 `EpisodeCleaned`，标题和描述会被清空。
- 文件会从存储中删除，但数据库记录会保留。

### 数据库记录删除

节目只有同时满足以下条件才会从数据库删除：

1. 平台 API 已经不再返回它。
2. 它仍是 `EpisodeNew`，从未下载过。

`EpisodeDownloaded` 和 `EpisodeCleaned` 不会被自动物理删除。当前没有内置旧记录压缩或裁剪机制。

## BadgerDB 行为

- 使用版本化 keyspace：`podsync/v1/`。
- feed key 前缀：`feed/{feedID}`。
- episode key 前缀：`episode/{feedID}/{episodeID}`。
- 数据使用 JSON 序列化。
- `keep_last` 只删除媒体文件，不删除数据库记录。
- 长期运行且 feed 很多时，数据库可能持续增长。

常见配置：

```toml
[database]
dir = "/path/to/db"

[database.badger]
truncate = true
file_io = true
```

## 配置速查

### Feed 配置

```toml
[feeds.my_feed]
url = "https://youtube.com/..."        # 必填：平台 URL
page_size = 50                         # 每轮查询节目数量，默认 50
update_period = "6h"                   # 更新频率，默认 6h
cron_schedule = "0 */6 * * *"          # cron 表达式，会覆盖 update_period
quality = "high"                       # "high" 或 "low"
format = "video"                       # "audio"、"video" 或 "custom"
max_height = 720                       # 视频最大高度
playlist_sort = "desc"                 # 播放列表排序："asc" 或 "desc"
filename_template = "{{id}}"           # 支持 {{id}}、{{title}}、{{pub_date}}、{{feed_id}}
opml = true                            # 是否加入 OPML 导出
private_feed = false                   # 是否阻止 podcast 聚合器索引
youtube_dl_args = ["--arg1", "val"]    # 额外传给 youtube-dl/yt-dlp 的参数
```

### 自定义下载格式

```toml
[feeds.my_feed.custom_format]
youtube_dl_format = "bestvideo+bestaudio"
extension = "mkv"
```

### 清理

```toml
[feeds.my_feed.clean]
keep_last = 10
```

### 过滤

过滤项之间是 AND 逻辑，节目必须满足所有配置项才会下载。

```toml
[feeds.my_feed.filters]
title = "(?i)(tutorial|guide)"
not_title = "(?i)(shorts|preview)"
description = "(?i)interview"
not_description = "(?i)sponsor only"
min_duration = 60
max_duration = 3600
min_age = 1
max_age = 365
```

### 自定义 feed 元数据

```toml
[feeds.my_feed.custom]
title = "Custom Title"
description = "Custom description"
author = "Author Name"
link = "https://example.com"
cover_art = "https://example.com/image.jpg"
cover_art_quality = "high"
category = "Technology"
subcategories = ["Software How-To"]
explicit = false
lang = "en"
ownerName = "Owner"
ownerEmail = "owner@example.com"
```

### Bilibili 配置

```toml
[feeds.bilibili_user]
url = "https://space.bilibili.com/291222529"

[feeds.bilibili_upower]
url = "https://space.bilibili.com/10835521"
bilibili = { include_upower_exclusive = true, cookies_file = "/app/config/bilibili-cookies.txt" }

[feeds.bilibili_season]
url = "https://space.bilibili.com/7380321/lists/678635?type=season"

[feeds.bilibili_series]
url = "https://space.bilibili.com/7458285/lists/1067956?type=series"
```

注意：

- `include_upower_exclusive = true` 只表示尝试包含“充电专属”视频；能否拉取和下载取决于 cookies 对应账号是否有权限。
- `cookies_file` 必须是 Netscape cookies.txt 格式。
- `bilibili.cookies_file` 会比单纯 `youtube_dl_args = ["--cookies", "..."]` 更完整，因为它同时用于 API 拉取和下载。

### Hooks

```toml
[[feeds.my_feed.post_episode_download]]
command = ["notify-send", "Downloaded: ${EPISODE_TITLE}"]
timeout = 60

[[feeds.my_feed.on_episode_download_error]]
command = ["logger", "Failed: ${ERROR_MESSAGE}"]
timeout = 60
```

可用环境变量：

- 下载成功 hook：`EPISODE_FILE`、`FEED_NAME`、`EPISODE_TITLE`。
- 下载失败 hook：`FEED_NAME`、`EPISODE_TITLE`、`ERROR_MESSAGE`。

### Server

```toml
[server]
port = 8080
hostname = "https://example.com"
bind_address = "*"
path = "feeds"
web_ui = false
tls = false
certificate_path = "/path/to/cert.pem"
key_file_path = "/path/to/key.pem"
debug_endpoints = false
no_index = false
no_listing = false
```

### Storage

```toml
[storage]
type = "local"

[storage.local]
data_dir = "/path/to/data"

[storage.s3]
endpoint_url = "https://s3.amazonaws.com"
region = "us-east-1"
bucket = "my-bucket"
prefix = "podsync"
```

### API Tokens

```toml
[tokens]
youtube = "API_KEY"
youtube = ["KEY1", "KEY2", "KEY3"]
vimeo = "TOKEN"
soundcloud = "KEY"
twitch = "CLIENT_ID:CLIENT_SECRET"
```

对应环境变量：

- `PODSYNC_YOUTUBE_API_KEY`
- `PODSYNC_VIMEO_API_KEY`
- `PODSYNC_SOUNDCLOUD_API_KEY`
- `PODSYNC_TWITCH_API_KEY`

多个 key 用空格分隔。

### Downloader

```toml
[downloader]
self_update = false
timeout = 15
custom_binary = "/path/to/yt-dlp"
```

### 全局清理

```toml
[cleanup]
keep_last = 50
```

### 日志

```toml
[log]
filename = "/path/to/podsync.log"
max_size = 100
max_backups = 3
max_age = 28
compress = true
debug = false
```

## 平台行为

### YouTube：`pkg/builder/youtube.go`

- 支持频道、用户、handle、播放列表。
- 自动跳过 live streams 和 Premiered videos。
- API 成本大致为：Channel/User 5 units、Handle 105 units、Playlist 3 units/request。
- 缩略图优先级：maxres > high > medium > default。
- 大小估算基于时长和质量，不是实际文件大小。
- 支持 `playlist_sort`。

### Vimeo：`pkg/builder/vimeo.go`

- 支持 channels、groups、users。
- API 分页，每页 50 条。
- 大小估算基于时长和分辨率。

### SoundCloud：`pkg/builder/soundcloud.go`

- 只支持 playlists，也就是 `/sets/` URL。
- 不支持单曲、用户主页、likes playlists。
- 不需要 API key。
- 大小根据时长粗略估算。

### Twitch：`pkg/builder/twitch.go`

- 支持用户频道的视频归档。
- 不支持 clips、highlights 和直播中内容。
- token 格式必须是 `CLIENT_ID:CLIENT_SECRET`。
- 每次请求最多 100 个视频。

### Bilibili：`pkg/builder/bilibili.go`

- 支持用户空间、season 列表、series 列表。
- Bilibili API client 会设置 `Origin`、`Referer`、`Accept-Language` 等请求头。
- 可通过 cookies 获取登录态、充电专属或受限视频信息。
- 下载阶段在 `pkg/ytdl/ytdl.go` 中追加 Bilibili headers 和临时 cookies 副本。
- 如果没有 cookies，公开视频仍应能正常发现和下载；受限视频可能失败。

## Web Server Endpoints

- `/{path}/{feed_id}.xml`：RSS/podcast feed。
- `/{path}/{feed_id}/{episode_name}`：节目文件下载。
- `/{path}/podsync.opml`：OPML 导出，包含 `opml = true` 的 feed。
- `/{path}/index.html`：Web UI，仅在启用且使用本地存储时可用。
- `/health`：健康检查；过去 24 小时有节目下载失败时返回 503。
- `/debug/vars`：运行指标；仅当 `debug_endpoints = true` 时启用。
- `/robots.txt`：仅当 `no_index = true` 时提供。

## 存储行为

### Local Storage

- 文件保存到 `{data_dir}/{feed_id}/{episode_name}`。
- Web UI 从 `./html/index.html` 提供。

### S3 Storage

- 文件 key 为 `{prefix}/{feed_id}/{episode_name}`。
- Podsync 不能直接代理提供 S3 文件，内容需要外部托管。
- 文件名迁移只支持 dry-run。
- Web UI 不可用。

### 文件名生成

- 支持 token：`{{id}}`、`{{title}}`、`{{pub_date}}`、`{{feed_id}}`。
- 默认模板是 `{{id}}`。
- 会清理非法字符并规整空白。
- `--migrate-filenames` 会把现有文件改名为当前模板对应的文件名。

## 错误处理

- YouTube 429：停止当前批次，下一轮重试。
- 下载失败：节目状态设为 `EpisodeError`，下一轮重试。
- API 失败：记录日志，调度器继续处理其他 feed。
- 下载超时：由 `downloader.timeout` 控制，默认 15 分钟。
- 可以用 `on_episode_download_error` hook 做失败通知。

## 已知限制

### 数据库

- 没有自动压缩或垃圾回收机制。
- 清理过的节目仍保留数据库记录。
- `keep_last` 只删除文件，不删除 DB 记录。
- 长期运行后数据库会随发现过的节目数量增长。

### 平台

- YouTube：自动跳过直播和 Premiered videos。
- SoundCloud：只支持 playlist URL。
- Twitch：只支持视频归档，不支持 clips/highlights。
- Bilibili：受限、会员或充电专属内容依赖 cookies 权限和平台风控状态。

### 存储

- S3：不能通过 Podsync 直接服务文件，也不支持真正执行文件名迁移。
- Local：Web UI 需要 `./html/index.html` 存在。

### 性能

- feed 更新是顺序执行，不是并行。
- 大播放列表按 50 条分页。
- 遍历数据库时会把节目加载到内存。

## 常用开发命令

### 构建

```bash
make build
make
```

### 测试

```bash
make test
go test -v ./...
go test ./pkg/...
```

### 格式化和 lint

```bash
gofmt -s -w .
goimports -w .
golangci-lint run
```

### 运行

```bash
./bin/podsync --config config.toml
./bin/podsync --debug
./bin/podsync --headless
./bin/podsync --no-banner
./bin/podsync --migrate-filenames
./bin/podsync --migrate-filenames --migrate-filenames-dry-run
```

### Docker

```bash
make docker
docker run -it --rm localhost/podsync:latest
```

## CI/CD

- CI 在 `push` 到 `main` 和针对 `main` 的 PR 上运行。
- CI 覆盖 Linux、Windows、macOS 构建，以及 Ubuntu 测试、覆盖率和 lint。
- Nightly workflow 在 `main` push、手动触发和每日定时触发时构建 multi-arch 镜像。
- Nightly 镜像：`ghcr.io/kyangc/podsync:nightly`。
- Release workflow 在推送 `v*` tag 时构建并推送：
  - `ghcr.io/kyangc/podsync:<tag>`
  - `ghcr.io/kyangc/podsync:latest`

## 开发约定

- 修改代码前先理解现有结构，优先沿用本仓库已有模式。
- 配置校验发生在启动阶段。
- 优雅退出通过 context cancellation 完成。
- 存储层通过抽象支持 local/S3。
- API key 轮换用于缓解单 key 配额限制。
- feed 调度支持 `update_period` 和 `cron_schedule`。
- Bilibili 相关行为要同时考虑 discovery 阶段和 `yt-dlp` 下载阶段。
- 修改 Bilibili cookies 行为时，必须确认不会污染源 cookies 文件。

## 提交前检查

代码变更提交前至少运行：

```bash
go fmt ./...
golangci-lint run
make test
```

仅文档变更不需要跑完整 Go 测试，但应检查 Markdown 链接、配置示例语法和 git diff。

## Git 工作流

- 除非用户明确要求，不要提交或推送。
- commit 要聚焦且原子化。
- commit title 简短清楚，必要时用 1-3 句 body 说明。
- 不要在 commit 或 PR 里添加自动生成签名。
- 不要添加 `Generated with Claude Code`。
- 不要添加 `Co-Authored-By: Claude ...`。

## GitHub Issue 处理

如果在 GitHub issue 中被要求 “take a look” 或 “can you fix this”：

- 先复现和定位问题。
- 能修就实现修复并开 PR。
- 如果需求不清或暂时不能修，在 issue 中说明阻塞点或需要的澄清。

## 维护本文档

修改代码行为时同步更新这份文档：

- 新功能：补充配置项、CLI flag、endpoint 或能力。
- 行为变化：更新节目处理、存储、清理、下载相关说明。
- 新平台支持：在“平台行为”里补充。
- API 变化：更新配置示例。
- 会影响用户认知的 bug fix：修正文档里对应行为。
- 新限制或限制解除：更新“已知限制”。

## 关键文件索引

- 主入口：`cmd/podsync/main.go`
- 配置加载：`cmd/podsync/config.go`
- Feed 更新：`services/update/updater.go`
- 节目过滤：`services/update/matcher.go`
- 数据库：`pkg/db/badger.go`
- 存储：`pkg/fs/local.go`、`pkg/fs/s3.go`
- RSS 生成：`pkg/feed/xml.go`
- 文件名迁移：`services/migrate/migrate.go`
- Web 服务：`services/web/server.go`
- YouTube builder：`pkg/builder/youtube.go`
- Vimeo builder：`pkg/builder/vimeo.go`
- SoundCloud builder：`pkg/builder/soundcloud.go`
- Twitch builder：`pkg/builder/twitch.go`
- Bilibili builder：`pkg/builder/bilibili.go`、`pkg/builder/bilibili_api.go`
- URL 解析：`pkg/builder/url.go`
- yt-dlp 封装：`pkg/ytdl/ytdl.go`
- Hooks：`pkg/feed/hooks.go`
- API key 轮换：`pkg/feed/key.go`
