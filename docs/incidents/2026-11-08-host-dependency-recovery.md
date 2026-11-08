# 2026-11-08：宿主解释器缺失与保护性停机

时间均为 Asia/Taipei（UTC+8）。**目前尚未恢复生产，等待人工完成 macOS 的 Python 3.15 可移除卷授权弹窗。**
依赖入口及 Podsync 专用恢复配置已修复，两个原消费者仍停止；没有把配置完成或 Worker 200 当作业务验收。

## 故障与原因边界

11/7 19:05:38，原恢复器的 `ssh.media_probe` 在约 213ms 后返回 RuntimeError。
诊断只留下 guest `session` 标记，没有进入 `listing`、写入或硬链接阶段；
原错误正文未被保留，故不能唯一确定当时会话标记读取/校验失败的具体原因。
当前宿主标记与原 generation 一致，也不能反证当时 NFS 会话正常。
这不是已证明的 11/4 APFS 停顿复发，亦不能把最初探针错误全部归因于 Python 路径。

恢复器随后撤租，按原持久 TERM 账本排空两个登记会话。
producer 于 19:05:39 开始关闭 cron/web，19:05:40 记录 `gracefully stopped`，
两个原 ID 均退出 0、非 OOM、RestartCount 0；这是故障保护性停机，不是已知的用户计划维护。
旧 NFS 已正常卸载并恢复只读 tmpfs，占位根未用于启动业务。

同轮三次原连接尝试均保留，最后于 19:06:19 blocked：
`/opt/homebrew/opt/python@3.14/bin/python3.14` 不存在。
原长期运行进程仍持有已移除的 3.14 解释器身份，无法再通过 `sys.executable`
启动受控传输；固定 `inspect_prefix` 的 3.14 入口也不存在。
两个消费者从此未恢复，媒体 `/healthz` 实际 502，本机 9091 不可达。
旧缓存可能返回 Range 206，不能据此确认源站可用。

宿主 shell 历史记录 19:02:47 的 `brew upgrade`、19:05:12 的 `brew cleanup`；
安装收据证明 Python 3.15.2 于 19:04:17、Node 26.13.0_2 于 19:04:37 安装。
这些将故障缩小到同窗宿主依赖变更，但没有文件删除操作审计，不能唯一证明哪个步骤
移除了旧解释器、OpenSSL opt 入口或缺失的 LaunchAgent 文件。

另一个已复现的依赖故障是 `/opt/homebrew/opt/openssl@4` 缺失：
原 4.1.0 keg 与动态库仍在，Homebrew 仍认为它已 linked。
这直接导致 Python `_ssl` 导入失败及 Homebrew Node 的 dyld 缺库，
并非已证明的 Cloudflare 凭据失效。已有 Volta Node 22.23.2 可执行只读 D1 查询；
短时 API 7403 与本地 dyld 故障分开记录，原凭据随后查询成功。

## 已实施的最小修复

- 用 Homebrew 正常 unlink/link 重新登记**同一 OpenSSL 4.1.0 keg**。
  操作前核对 6,708 个现有链接均属于该 keg，保存链接清单；动态库 SHA 前后相同。
  没有升级或重新安装软件包。修复后 Python SSL 和 Homebrew Node 均可加载，
  原默认 Wrangler 入口完成 `SELECT 1`、`rows_written=0`。
- 仅将 Podsync `inspect_prefix` 和恢复器启动入口改为已有 Python 3.15，
  恢复缺失的持久 LaunchAgent 定义。应用镜像、两个消费者 ID/配置指纹、
  控制器 79bbbe2、观察 helper f591dea、全局 wrapper 与实际 v2 gate 字节保持。
- 核对原正常排空后，停止已 blocked 的旧控制器，确认无旧 owner/传输和运行 writer。
  原 NFS 正常卸载并确认只读占位；配置/activation 哈希重新登记。
  完整保留 56 条 inspection 历史、原失败、三次自动尝试、原 TERM 账本与未知结果，
  追加 reviewed block/handoff。依既有单次许可机制登记一次受控连接额度，**尚未消耗**。
- 新控制器尚未 bootstrap，状态保持 blocked，等待人工处理系统权限。
  没有手造租约、直接启动消费者、清预算、重放任务、恢复旧 VM/NAS writer 或绕过系统权限。

同机 Monga 已实际观察到新的后台 Python 3.15 等待可移除卷访问授权，
其 NFS 打开根目录请求停在受保护系统弹窗。终端中的成功读取沿用 Codex 权限，
不能证明后台恢复器已获准。Podsync 因此没有再发起明知受阻的连接。
需要用户在 Mac 系统弹窗中允许访问，并确认弹窗处理完成；工具不能代点该受保护弹窗。

## 已验证的证据与尚未完成的验收

截至 08:14：

| 检查 | 实际结果 |
| --- | --- |
| 原日志 | 按原 ID 归档截至 drain 的近 24h；producer 83,196 行、11,161,804 字节；media 95 行、16,790 字节；读回大小/SHA、全部时间戳与完整行通过，producer 正常退出尾部通过 |
| 日志范围 | 查询从 11/6 19:05:40 至 11/7 19:05:40；窗内首条 producer 19:10:23、media 19:07:44，未填造正常无日志间隔；目录 0700、文件 0600 |
| 停机库 | 独立只读审查全部值可解析，不启动第二 writer；outbox 0、pending publish 0，持久 tombstone cursor 3294 |
| D1 | 11/7 07:00 后的 12 轮均 success；连续唯一序号和计数匹配，查询均 rows_written 0；最后一轮在 19:05:39 正常闭合，之后约 13h 没有新业务事件 |
| 删除账本 | 08:14 远端高水位 3296，本地 3294；新增 2 条待原进程自然消费，未手改 cursor 或媒体 |
| 配置与 Cookie | 源 SHA/mtime 保持，原挂载只读契约保留；12 项冻结制品哈希保持 |
| 兼容性 | 与控制器 79bbbe2 匹配的完整隔离 fixture：129 项测试通过，包含门禁、ACK、未知结果与预算保护；最初 fixture 缺辅助源码导致的失败已保留，补齐原提交文件后通过 |
| 平台检查 | 33 组规定本地检查通过；默认新 Python 缺 PyYAML，验证时仅隔离复用保留下来的 PyYAML 6.0.3 纯 Python 文件，未安装软件包 |
| 当前生产 | 原两消费者仍 exited，原 writer 数 0；新连接额度未消耗；尚无新 ready/ACK/双实际 gate/健康/交付验收 |

公开 Worker 与 RSS 的存活、D1 errors 0、原任务 success 均不消除当前停机影响。
11/7 08:09:55 的下载器自更新失败是一次 GitHub HTTP403/rate-limit 操作，
日志两条 error 不算两次事故；没有据此更新下载器、改变业务频率或掩盖当前停机。

## 接续与回退

人工完成系统弹窗后，先确认后台原根目录访问请求真正解除，再恢复**原控制器**的完整准入。
一次原机制许可只用于一条新受控传输；任何新的未知握手/挂载/写入结果须保留并重新审查，
不能无界重试。原完整 nonce ACK、boot ID/generation、双时钟 10s TTL、2s 发布预算及
3s SSH/观察期限均不变。

完成标准仍包括：实际 ready、同制品与单 writer、完整 ACK/TTL、双消费者实际 gate、
Linux 内部健康、自然 feed/下载/发布/上报新鲜度、原 cursor 自然消费至远端高水位，
以及 RSS enclosure 唯一、D1/源大小、Mac/NAS Range 206/1024 字节/总长/前缀和 Access。
稳定观察须覆盖自然业务，不能用一次启动或 HTTP200 结案。

回退也必须使用当前完整历史和预算，核对会话后正常排空/卸载/关闭传输，再登记已验证的
可用解释器；不能恢复旧 state 快照或指向已不存在的 3.14 路径。

私有证据及可复核接续脚本位于内置盘
`runtime/private/podsync-dependency-recovery-20261108/`，包括原始状态/诊断、日志清单、
只读库与 D1 结果、依赖链接清单、测试、准备回执与回退步骤。
系统授权确认回执尚不存在，接续脚本不会在缺少该实际人工确认时运行。
