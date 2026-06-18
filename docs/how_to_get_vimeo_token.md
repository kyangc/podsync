# 获取 Vimeo API Token

1. 在 https://vimeo.com 创建账号。
2. 打开 https://developer.vimeo.com
3. 点击 `New app`。
![Create a new app](img/vimeo_create_app.png)
4. 点击 `Create App`。
5. 进入 [Generate an access token](https://developer.vimeo.com/apps/160740#generate_access_token) 区域。
![Generate an access token](img/vimeo_access_token.png)
6. 点击 `Generate`。
![Tokens](img/vimeo_token.png)
7. 复制生成的 token，写入 Podsync 配置文件，或设置为环境变量。

配置文件写法：

```toml
[tokens]
vimeo = "key1"
```

环境变量写法：

```bash
export PODSYNC_VIMEO_API_KEY="key1"
```

如果要轮换多个 API key，用空格分隔：

```bash
export PODSYNC_VIMEO_API_KEY="key1 key2"
```
