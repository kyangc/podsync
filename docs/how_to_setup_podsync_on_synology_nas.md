# 在 Synology NAS 上运行 Podsync

原文作者：[@lucasjanin](https://github.com/lucasjanin)

以下示例演示如何在 Synology NAS 上运行 Podsync，并通过 443/HTTPS 访问。它假设你已经有一个域名、DDNS 和 SSL 证书。如果只在局域网使用，可以简化 HTTPS 和反向代理部分。

示例使用本 fork 的镜像 `ghcr.io/kyangc/podsync`。如果只想测试最新 `main` 构建，可以把 `:latest` 换成 `:nightly`。

1. 打开“套件中心”，安装 “Apache HTTP Server 2.4”。
2. 在 “Web Station” 中选择默认服务器，点击编辑，并启用个人网站。
3. 用 “File Station” 在 web 共享目录下创建 `podsync` 文件夹，例如 `/volume1/web/podsync`。这里用于保存下载的节目文件。
4. 用 “File Station” 在 docker 共享目录下创建 `podsync` 文件夹，例如 `/volume1/docker/podsync`。这里用于保存配置文件。
5. 用记事本或其他编辑器创建 `config.toml`，复制到 `/volume1/docker/podsync`。下面是一个示例：

```toml
[server]
port = 9090
hostname = "https://xxxxxxxx.xxx"

[storage]
  [storage.local]
  data_dir = "/app/data"

[tokens]
youtube = "xxxxxxx"

[feeds]
    [feeds.ID1]
    url = "https://www.youtube.com/channel/UCJldRgT_D7Am-ErRHQZ90uw"
    update_period = "1h"
    quality = "high" # "high" 或 "low"
    format = "audio" # "audio"、"video" 或 "custom"
    filters = { title = "Yann Marguet" }
    opml = true
    clean = { keep_last = 20 }
    private_feed = true
    [feeds.ID1.custom]
    title = "Yann Marguet - Moi, ce que j'en dis..."
    description = "Yann Marguet sur France Inter"
    author = "Yann Marguet"
    cover_art = "https://www.radiofrance.fr/s3/cruiser-production/2023/01/834dd18e-a74c-4a65-afb0-519a5f7b11c1/1400x1400_moi-ce-que-j-en-dis-marguet.jpg"
    cover_art_quality = "high"
    category = "Comedy"
    subcategories = ["Stand-Up"]
    lang = "fr"
    ownerName = "xxxx xxxxx"
    ownerEmail = "xx@xxxx.xx"
```

这里没有使用 `8080`，是因为 Synology 上可能已经有其他服务占用该端口。`hostname` 用于生成 RSS 里的外部访问链接；如果只在局域网使用，可以不配置公网域名。

6. 通过 SSH 登录 Synology。
7. 拉取镜像：

```bash
docker pull ghcr.io/kyangc/podsync:latest
```

8. 启动容器：

```bash
docker run \
    -p 9090:9090 \
    -v /volume1/web/podsync:/app/data/ \
    -v /volume1/docker/podsync/config.toml:/app/config.toml \
    ghcr.io/kyangc/podsync:latest
```

Podsync 会读取 `config.toml`，开始拉取 feed 并下载节目。

9. 建议在 Container Manager / Docker 的容器设置中开启自动启动。
10. 下载完成后，每个 feed 都会生成 XML。示例 feed 地址类似 `https://xxxxxxxx.xxx/podsync/ID1.xml`，把它复制到 podcast 客户端即可订阅。

可以用这个网站验证 XML 是否有效：https://www.castfeedvalidator.com/validate.php
