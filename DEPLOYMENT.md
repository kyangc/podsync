# 运行与部署约定 · 2026-10-25

## 当前状态

生产 stack 目录为 `/Volumes/4T/DockerData/platform/stacks/podsync`。
生产及媒体持久数据位于已登记的 4T Linux volumes 和 `/Volumes/4T/PublishedMedia/podsync`。
用户现用订阅域名为 `podsync.kyangc.net`，原 `router.kyangc.com:9092` 已关闭。

NAS producer 和媒体容器已停止；不要用旧 NAS 容器检查结果判断现有生产。
修改发现、下载、cookies 或媒体发布后，需要在对应 Linux 镜像与真实挂载中验证，
保持源 cookies、Badger、媒体路径和硬链接语义，不能只在 Mac 跑 Go 程序后宣布生产已修复。

## 生产运维约定

- 生产服务使用 Mac mini 的 Colima `platform` 与 Dockge；平台目录为 `/Volumes/4T/DockerData/platform`。
- 在 Mac 宿主上管理 Docker 时，命令统一通过 `/Users/chengkangyang/.local/bin/docker-platform docker ...`；不要默认使用其他 Docker context、创建第二台 VM 或重装一套生产服务。
- 生产问题先检查实际 Compose、容器状态/日志、挂载数据及业务接口。Mac 上的 `node`、Python、Homebrew 或开发测试结果不能替代 Linux 容器验收。
- 改动运行时代码后，按当前源码和锁文件构建对应镜像，更新原 Compose 并检查实际业务结果；不要仅修复宿主依赖后宣称生产已修复。
- 持久状态、业务日志和凭据放在 4T 的已登记目录或 Linux volumes；凭据不进入镜像、仓库或聊天输出。保留原身份、队列与未知结果，不重放来历不明的任务。
- 允许在 Mac 编辑、构建和运行开发测试；不要把这误当成恢复 Mac 原生生产服务。宿主 TUN、VM 网络模式和时钟不是项目故障的默认修改对象。

已在容器内时，直接使用该容器的 Linux Node/Python 与挂载状态执行应用检查；不要安装 macOS 工具、恢复宿主 LaunchAgent 或尝试在业务容器中启动第二套 Docker。
