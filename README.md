# Podsync

![Podsync](docs/img/logo.png)

[![](https://github.com/kyangc/podsync/workflows/CI/badge.svg)](https://github.com/kyangc/podsync/actions?query=workflow%3ACI)
[![Nightly](https://github.com/kyangc/podsync/actions/workflows/nightly.yml/badge.svg)](https://github.com/kyangc/podsync/actions/workflows/nightly.yml)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/kyangc/podsync)](https://github.com/kyangc/podsync/releases)
[![Go Report Card](https://goreportcard.com/badge/github.com/mxpv/podsync)](https://goreportcard.com/report/github.com/mxpv/podsync)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/mxpv)](https://github.com/sponsors/mxpv)
[![Patreon](https://img.shields.io/badge/support-patreon-E6461A.svg)](https://www.patreon.com/podsync)

Podsync 是一个简单、免费的服务，可以把在线视频频道、合集、列表或用户空间转换成 podcast feed。这样就能在 podcast 客户端里自动下载新节目、记录播放进度、跨设备同步，并离线收听/观看。

## 本 Fork 的定位

本仓库以 upstream [`mxpv/podsync`](https://github.com/mxpv/podsync) 的 `main` 分支为基底，目标是继续使用 Podsync 的最新能力，同时补齐 Bilibili 视频转 podcast 的能力。旧 fork [`yangtfu/podsync`](https://github.com/yangtfu/podsync) 中的 Bilibili 思路是重要参考，但当前实现已经重新落在 upstream 的新版代码结构上。

这个 fork 主要做了这些事：

- 新增 Bilibili provider，支持 Bilibili 用户空间、合集列表 `type=season`、系列列表 `type=series`。
- 支持可选拉取“充电专属”视频：配置 `bilibili.include_upower_exclusive = true`，并提供有效的 Bilibili cookies。
- Bilibili 不要求官方 API token；启动阶段也不会因为 `[tokens] bilibili = ""` 这类旧配置失败。
- Bilibili API 请求和 `yt-dlp` 下载都会带上 B 站常见 headers，降低 412 等反爬/风控问题。
- `bilibili.cookies_file` 会同时用于 Bilibili API 拉取和 `yt-dlp` 下载；下载时 Podsync 会先复制一份临时 cookies，避免 `yt-dlp` 回写污染源 cookies 文件。
- 新增 `filename_template`，可控制下载文件名和 RSS enclosure 路径；同时提供一次性迁移命令。
- GitHub Actions 已切到本仓库，`main` 会发布 `ghcr.io/kyangc/podsync:nightly`，推送 `v*` tag 会发布正式镜像。

Go module 路径仍保留为 `github.com/mxpv/podsync`，这是为了尽量减少和 upstream 的差异；镜像、CI/CD 和发布产物使用 `kyangc/podsync`。

## 功能

- 支持 YouTube、Vimeo、SoundCloud、Twitch 和 Bilibili。
- feed 可配置视频/音频、高/低质量、最大视频高度等。
- 支持 mp3 编码。
- 更新调度支持 cron 表达式。
- 支持按标题、描述、时长、发布时间过滤节目。
- 支持自定义 feed 元数据，例如封面、分类、语言等。
- 支持 OPML 导出。
- 支持清理旧节目文件，例如只保留最近 N 期。
- 支持下载后和下载失败 hook，方便接入通知或自定义流程。
- 支持 AWS 一键部署。
- 支持 Windows、macOS、Linux 和 Docker。
- 支持 ARM。
- 支持 `yt-dlp` 自动更新。
- 支持 API key 轮换。

## 依赖

如果直接运行二进制程序，而不是使用 Docker，需要确保系统里已经安装 `yt-dlp`、`ffmpeg` 和 `go`。

macOS 可以用 Homebrew 安装：

```bash
brew install yt-dlp ffmpeg go
```

## 文档

- [配置样例](./config.toml.example)
- [节目过滤器](./docs/filters.md)
- [用 cron 调度更新](./docs/cron.md)
- [获取 YouTube API Key](./docs/how_to_get_youtube_api_key.md)
- [获取 Vimeo API token](./docs/how_to_get_vimeo_token.md)
- [在 QNAP NAS 上运行 Podsync](./docs/how_to_setup_podsync_on_qnap_nas.md)
- [在 Synology NAS 上运行 Podsync](./docs/how_to_setup_podsync_on_synology_nas.md)

## Nightly 镜像

Nightly 镜像会从 `main` 分支构建，并推送到 GHCR，适合日常自测或跟进最新修复：

```bash
docker run -it --rm ghcr.io/kyangc/podsync:nightly
```

## Access Tokens

YouTube 和 Vimeo API 需要先申请 token。Bilibili feed 不需要官方 API token，但仍然可能受到平台风控、登录态、限流等影响。

- [获取 YouTube API key](https://elfsight.com/blog/2016/12/how-to-get-youtube-api-key-tutorial/)
- [生成 Vimeo access token](https://developer.vimeo.com/api/guides/start#generate-access-token)

## 配置

先创建配置文件，例如 `config.toml`，然后写入需要托管的 feed。完整配置项见 [config.toml.example](./config.toml.example)。

最小配置大致如下：

```toml
[server]
port = 8080

[storage]
  [storage.local]
  # 使用 Docker 运行时通常不要改这个路径
  data_dir = "/app/data/"

[tokens]
youtube = "PASTE YOUR API KEY HERE" # 也可以通过环境变量配置，见 config.toml.example

[feeds]
    [feeds.ID1]
    url = "https://www.youtube.com/channel/UCxC5Ls6DwqV0e-CYcAKkExQ"
```

Bilibili 用户空间、充电专属、合集和系列示例：

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

如果把 Podsync 放在 nginx 等反向代理后面，可以配置 `hostname`：

```toml
[server]
port = 8080
hostname = "https://my.test.host:4443"

[feeds]
  [feeds.ID1]
  ...
```

服务仍然监听 `http://localhost:8080`，但 RSS 中的节目链接会指向 `https://my.test.host:4443/ID1/...`。

### 环境变量

Podsync 支持以下环境变量：

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `PODSYNC_CONFIG_PATH` | 配置文件路径，会覆盖 `--config` 参数 | `/app/config.toml` |
| `PODSYNC_YOUTUBE_API_KEY` | YouTube API key；多个 key 用空格分隔以启用轮换 | `key1` 或 `key1 key2 key3` |
| `PODSYNC_VIMEO_API_KEY` | Vimeo API key；多个 key 用空格分隔以启用轮换 | `key1` 或 `key1 key2` |
| `PODSYNC_SOUNDCLOUD_API_KEY` | SoundCloud API key；多个 key 用空格分隔以启用轮换 | `soundcloud_key1 soundcloud_key2` |
| `PODSYNC_TWITCH_API_KEY` | Twitch API 凭据，格式为 `CLIENT_ID:CLIENT_SECRET` | `id1:secret1 id2:secret2` |

### 把 Cookies 传给 yt-dlp

一些来源需要登录态或会触发平台风控，Bilibili 的会员/充电专属视频尤其常见。Podsync 会把 `feeds.<ID>.youtube_dl_args` 原样传给 `yt-dlp`，因此可以传入 Netscape 格式的 cookies 文件：

```toml
[feeds.members]
url = "https://space.bilibili.com/291222529"
youtube_dl_args = ["--cookies", "/app/config/cookies.txt"]
```

对 Bilibili，更推荐使用 `bilibili.cookies_file`，因为它同时作用于 Bilibili API 请求和 `yt-dlp` 下载：

```toml
[feeds.members]
url = "https://space.bilibili.com/10835521"
bilibili = { include_upower_exclusive = true, cookies_file = "/app/config/bilibili-cookies.txt" }
```

下载 Bilibili 视频时，Podsync 会把源 cookies 文件复制到本次下载的临时目录，再把临时副本传给 `yt-dlp`。这样即使 `yt-dlp` 回写 cookies，也不会改坏你挂载进容器的源文件。

## 运行

### 编译并以二进制运行

先创建 `config.toml`。如果不是 Docker 环境，注意 `data_dir` 应该指向当前系统可写的目录，`/app/data` 不一定存在。

```bash
git clone https://github.com/kyangc/podsync
cd podsync
make
./bin/podsync --config config.toml
```

### 一次性文件名迁移

如果调整了 `filename_template`，并希望把已经下载的文件迁移到新命名规则：

```bash
./bin/podsync --config config.toml --migrate-filenames
```

只预览、不写入：

```bash
./bin/podsync --config config.toml --migrate-filenames --migrate-filenames-dry-run
```

注意：当 `storage.type = "s3"` 时，目前只支持 dry-run。真正迁移需要能读取旧文件，因此要在本地存储上执行。

### 调试

可以使用 [Visual Studio Code](https://code.visualstudio.com/) 加官方 [Go 扩展](https://marketplace.visualstudio.com/items?itemName=golang.go) 调试。仓库已经准备了 `.vscode/launch.json`，可直接选择 "Run & Debug" -> "Debug Podsync"。

### 使用 Docker 运行

```bash
docker pull ghcr.io/kyangc/podsync:latest
docker run \
    -p 8080:8080 \
    -v $(pwd)/data:/app/data/ \
    -v $(pwd)/db:/app/db/ \
    -v $(pwd)/config.toml:/app/config.toml \
    ghcr.io/kyangc/podsync:latest
```

### 使用 Docker Compose 运行

```yaml
services:
  podsync:
    image: ghcr.io/kyangc/podsync
    container_name: podsync
    volumes:
      - ./data:/app/data/
      - ./db:/app/db/
      - ./config.toml:/app/config.toml
    ports:
      - 8080:8080
```

```bash
docker compose up
```

## 发布

推送 `v*` tag 后，Release workflow 会构建并推送正式镜像：

- `ghcr.io/kyangc/podsync:<tag>`
- `ghcr.io/kyangc/podsync:latest`

Nightly 镜像则由 `main` 分支构建：

- `ghcr.io/kyangc/podsync:nightly`

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
