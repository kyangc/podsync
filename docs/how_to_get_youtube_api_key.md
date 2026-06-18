# 获取 YouTube API Key

1. 打开 https://console.developers.google.com
2. 点击 `Select a project`。
![Select project](img/youtube_select_project.png)
3. 点击 `New project`。
![New project](img/youtube_new_project.png)
4. 填写项目名称，然后点击 `Create`。
![Dashboard](img/youtube_dashboard.png)
5. 点击 `Library`，找到并打开 `YouTube Data API v3`。
![YouTube Data API](img/youtube_data_api_v3.png)
6. 点击 `Enable`。
![YouTube Enable](img/youtube_data_api_enable.png)
7. 点击 `Credentials`。
8. 点击 `Create credentials`。
9. 选择 `API key`。
![Create API key](img/youtube_create_api_key.png)
10. 复制生成的 key，写入 Podsync 配置文件，或设置为环境变量。
![Copy token](img/youtube_copy_token.png)

配置文件写法：

```toml
[tokens]
youtube = "key1"
```

环境变量写法：

```bash
export PODSYNC_YOUTUBE_API_KEY="key1"
```

如果要轮换多个 API key，用空格分隔：

```bash
export PODSYNC_YOUTUBE_API_KEY="key1 key2"
```
