# 在 QNAP NAS 上运行 Podsync

原文作者：[@Rumik](https://github.com/Rumik)

以下示例使用本 fork 的镜像 `ghcr.io/kyangc/podsync`。如果只想测试最新 `main` 构建，可以把 `:latest` 换成 `:nightly`。

1. 在 App Center 安装 Container Station。
2. 在 QNAP 上创建一个共享目录，用来保存 Podsync 配置和数据，例如 `/share/CACHEDEV1_DATA/appdata/podsync`。
3. 用记事本或其他编辑器创建 `config.toml`，复制到上面的目录。下面是一个简单示例：

```toml
[server]
port = 6969
hostname = "http://my.customhostname.com:6969"

[storage]
  [storage.local]
  data_dir = "/app/data"

[tokens]
youtube = "INSERTYOUTUBEAPI"

[feeds]
  [feeds.KFGD]
  url = "youtube.com/playlist?list=PLy3mMHt2i7RIl9pkdvrA98kN-RD4yoRhv"
  page_size = 3
  update_period = "60m"
  quality = "high"
  format = "video"
  cover_art = "http://i1.sndcdn.com/avatars-000319281278-0merek-original.jpg"
```

这里没有使用 `8080`，是因为 NAS 上可能已经有其他服务占用该端口。你可以换成任意未占用端口。`hostname` 用于生成 RSS 里的外部访问链接；如果只在局域网使用，可以不配置公网域名。如果要从外网订阅，需要在路由器上把对应端口转发到 QNAP。

4. Container Station 安装完成后，通过 SSH 登录 QNAP。
5. 拉取镜像：

```bash
docker pull ghcr.io/kyangc/podsync:latest
```

6. 启动容器：

```bash
docker run \
    -p 6969:6969 \
    -v /share/CACHEDEV1_DATA/appdata/podsync/data:/app/data/ \
    -v /share/CACHEDEV1_DATA/appdata/podsync/config.toml:/app/config.toml \
    ghcr.io/kyangc/podsync:latest
```

Podsync 会读取 `config.toml`，开始拉取 feed 并下载节目。

7. 建议在 Container Station 的容器设置里开启 Auto Start。
8. 下载完成后，每个 feed 都会生成一个 XML feed。访问 `http://ipaddressorhostname:6969/`，复制对应 feed 地址到 podcast 客户端即可订阅。
