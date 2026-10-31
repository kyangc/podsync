# 2026-10-31：维护卸载后同盘重连的恢复缺口

本轮处理用户换数据线、补电线和 USB 控制器路径后的实际媒体恢复问题，
与[早间历史超时](2026-10-31-bounded-diagnostics.md)分开。旧 HTTP/TLS、下载及预算问题
不作为本次根因。时间均为 Asia/Taipei（UTC+8）。

## 确认现场与第一阶段恢复

21:54:44 Finder 请求卸载，21:54:51.412 正常卸载，21:55:31 RTL9210 物理断开；
22:08:43.282 重新枚举，22:08:45.528 原 UUID 的 4T 在原路径重挂。
这是用户维护操作，不计为新自发掉盘；同时改变了线材、补电和端口/控制器路径，
不能单独归因于其中任一项，也不能从短窗读取正常声称硬件长期根治。

Podsync 21:54:52.436 起三次身份流报 `FileNotFoundError: 2`，21:54:57.710 blocked。
22:24 实际读回两个消费者 running/unhealthy、原 v2 gate 均返回 75；
旧 NFS server 仍存在，lsof 确认其根描述符为 revoked。
原卷宿主可读不代表容器旧挂载可用。

已部署身份流把不存在的卷路径异常封装成 `ok:false`，随后统一抛 InspectTimeout；
三次后 blocked 分支仅撤租，不再执行身份观察、排空和换会话。
本轮保全的三条原始诊断均停在 `native_begin`，与 native 卷属性读取阶段 ENOENT 一致，
不是把缺 helper 或后续节目路径异常猜作缺盘。
隔离不存在的 mount fixture 连续三次稳定复现同一错误，未拔生产盘。
共享核心的最终修复由 Monga 修复线程统一负责，本线程不并发改该文件。

第一阶段先按原登记和安全流程恢复实际服务：

- 保全 config/activation/state/诊断、传输进程信息和原 ID 日志。
  22:27 两消费者正常 TERM 并退出 0，没有 force kill、删除容器或重放任务。
- 截至 drain 的原 ID 近 24 小时 stdout/stderr 已归档、读回并保存大小、SHA-256、
  时间边界和退出状态；目录 0700、文件 0600。producer 在 15:16 创建，不足 24 小时，
  明确记录其整个可用实例生存期；media 容器保留同 ID 历史启动日志。
- 归档辅助脚本先后因“最新 StartedAt 被当成旧日志起点”和“停止后仍要求运行 writer=1”
  的预检断言退出，均在卸载/换会话前停止并保留原失败。前者改按 Created/查询区间验证，
  后者按实际 Running 状态验证 writer 为 0；未放宽容器指纹、退出或写入未知边界。
  nginx 可正常退出而无尾部日志，依据 ExitCode/FinishedAt、完整原 ID 查询和 producer
  正常退出尾部共同核实，不能要求它生成原本没有的日志。
- 22:29:16 正常卸载失效 NFS 并恢复只读占位，随后正常关闭原 owner/传输并确认原 PID 消失。
  原 blocked 状态另存受限快照及哈希，追加 reviewed block；保留全部原事故、人工预算和
  自动 attempts，仅交给原控制器执行完整重新准入，没有手工设置 ready 或制造租约。
- 22:29:21 原控制器恢复 ready，两个原容器 ID 重新启动，消耗一次原自动连接额度。
  应用镜像/二进制、配置、源 Cookie、媒体、Badger/队列及未知结果保持。
  未操作 Monga 制品、主机/VM、网络/时钟或 Usage Calendar/ETF。

22:32:37 验收：两消费者 healthy、RestartCount 0、双实际 gate 通过；
完整 nonce ACK、boot ID/generation 与原十秒 wall/BOOTTIME TTL 通过，剩余约 9.71 秒。
原 55 条事故及人工预算保留，只由正常 confirmed_ready 给最后事件追加 resolved_at；
唯一 writer、新传输有效根、源配置/Cookie 哈希和 mtime 保持。
内部 health healthy，完整 feed 发布自然推进至 22:31:13。

三个原 RSS 样本经 producer 源站返回 200，长度/内容 SHA 与当前宿主源一致；
自然启动发布更新了 XML，不能要求其与 22:13 的旧 XML 字节不变。
原音频 Range 206/1 MiB、总长度和内容 SHA 同时匹配当前源及 22:13 维护后宿主样本。
另两个已发布音频经 nginx 源站 Range 206/1024，大小和前缀匹配原真实源；
这些是容器源站验证，没有用公网缓存替代。

受限证据及持续进展：
`/Users/chengkangyang/DockerPlatform/runtime/private/usb-stability-research-20261031/after-cabling-2210/podsync-recovery/`，
同级 `podsync-recovery-progress.md`。

## 自动恢复修复与分阶段验收

第一阶段为经审查的人工恢复，不能据此声称正常断联复连已经能自动恢复。
共享核心 `cf4d170` 实现了以下边界，后续最终提交 `80e5ed8` 进一步收紧未知清理和准入错误：

- native 卷观察已完成并报 ENOENT，且 mount 的 lstat 同样不存在、父目录可观察时，
  确认为介质暂离；缺 helper、现有路径上的异常、I/O/权限和真正观察器失败继续为未知。
- 确认介质不可用先撤租，持久化原 ID/StartedAt 的 TERM 意图，每个原会话最多一次信号。
  已确认本地命令清理完成的超时只读对账；原会话正常退出才继续。
  owner 在 prepared 状态中断、清理未确认、换会话、writer 非零/OOM 仍要求审查。
- 消费者退出后先正常卸载 NFS，再停止旧传输；同 UUID 重挂的失效根也必须完整换会话、
  remount/proof/probe、原 ACK/双时钟 TTL 验证后重新准入。
- Darwin 对已退出 leader 的进程组清理可报 EPERM，不能遮蔽原超时；未确认清理的活请求
  使用独立未知类别保持 blocked。连接握手之后的 mount/proof/准入错误不再落入连接 backoff，
  不重试未知写入。错误卷/只读盘、预算耗尽继续拒绝。

旧已部署身份流对实际不存在的隔离路径连续三次返回 InspectTimeout；新制品连续三次返回
`False`。旧版本无法通过同一组重连回归；最终核心新增 14 项回归与 Podsync 两消费者
生命周期用例通过，平台维护线程的 30 项显式本地检查通过。测试只在隔离临时目录/进程运行，
未拔生产盘、断网、造 OOM 或重启 VM。共享源码和回归由同一线程提交，本线程只冻结和部署
Podsync 专用制品，原全局 wrapper 和实际 v2 gate 不变。

22:44:17 中间 `cf4d170` 专用控制器完整准入，原 ID/应用镜像保持；该次正常交接约 6 秒。
22:47:17 通过原已登记的 `state/media-recovery/podsync/paused` 演练：约 22:47:22 自动撤租、
两个消费者退出 0，原 NFS 卸载为只读 tmpfs，旧传输消失。辅助离线 gate 探针错误地用
Python 解释 ELF 二进制，断言失败原样保留；在同一 offline 检查点改为直接执行登记制品，
Linux gate 返回 75，未重新创建暂停或重发 TERM。
22:48:22 移除本线程专用暂停标记，约 22:48:26 自动完成新传输/新 generation/完整重新准入，
双实际容器 gate 均返回 0，原 ID 保持。Monga 的 ID/StartedAt 未变。
演练只验证服务生命周期，不能替代真实物理拔插覆盖；硬件长期稳定性仍未证实。

中间版本演练后的 22:49:38 生产读回：ready、事故 55、双 gate/healthy、单 writer、
完整 ACK 和原十秒双时钟 TTL 通过；实际二进制/source manifest 仍对应应用 `9efb508`，
最近完整 feed 发布 22:49:34。源配置/Cookie 哈希/mtime 不变。
应用诊断存量 82 条/78,433 字节，恢复器 73 条/72,438 字节；已持久记录内
dropped/write_failures 快照为 0。22:29 后应用失败诊断仅 6 条既有 discovery -404 跳过，
恢复器的 draining/offline 记录是此次暂停流程，不能当作新增事故。

22:51:53 的只读 D1 核对六轮 sequence 唯一连续且计数相符。
维护失联期原轮次保留 partial/28 errors；22:29 后三轮共自然完成 84 feed、
1 次下载（22:30:17）、发布/上报（22:34:27），errors 0、无重复发布组。
原自动任务和错误没有重放/删改。
首次只读请求曾返回 7403；只读 whoami 确认现有 OAuth/同一账户后，同条件普通重试通过，
成功 SELECT 的 rows_written 均为 0。未替换凭证或修改账户配置，原失败仍保留，
不能宣称已查明其具体原因，也不再把远端核验写为持续阻塞。

最终 `80e5ed8` 专用制品通过隔离回归后，先等待原 600 秒稳定规则自然释放连接额度，
再完成下节的定点交接和复验；没有手工清预算或补发许可。

## 最终制品部署及实际自动恢复

22:59:00 读回原控制器已稳定 633 秒，原规则自然将 attempts 释放为 0；
没有人工清理状态或新增许可。随后正常排空、验证截至 drain 的原 ID 日志、卸载并关闭原传输，
22:59:03 启动最终 `80e5ed835191c578c28846c65ef6ec8935073929` 控制器，
22:59:09 完整准入。原容器 ID/应用镜像/门禁保留，制品目录为
`runtime/control/media-recovery-podsync-reconnect-20261031-final/`，包含同提交的
`lease_diagnostics.py` 和原 `f591dea` 观察 helper 字节；每件制品及 manifest 均登记哈希。
新增清理分类是共享机制的补充安全审阅，不能把 Monga 的旧探针事件套作 Podsync 本次触发。

最终制品又单独完成一次实际演练：

- 23:01:20.858 创建原已登记的 Podsync 专用暂停标记，没有操作 4T 或 Monga 标记。
- 23:01:25.073 确认自动 offline：两消费者正常退出 0、原租约不存在、正常卸载为只读 tmpfs、
  旧传输消失、原登记 Linux gate 直接执行返回 75。每个原会话 TERM 恰一次，日志已归档验证。
- 23:01:25.074 移除本线程的暂停标记，没有改 ready、generation、租约或预算。
  23:01:28 自动完成新传输/新 generation/完整重新准入，原 ID 双实际 gate 返回 0。
  attempts 从 1 到 2，原历史/人工预算保留；Monga 的 ID/StartedAt 未变。

23:01:36–37 读回双 healthy、RestartCount 0、单 Badger writer、完整 ACK 和原双时钟十秒 TTL，
剩余约 9.73 秒；源配置/Cookie 哈希/mtime、应用实际二进制/source manifest `9efb508` 均匹配。
内部成功时间已自然推进至 23:01:35。三个 RSS、原音频及两个已发布 nginx 音频源站复核仍通过。
另核对维护恢复后自然下载的新媒体 21,061,597 字节：实际双硬链接、D1 大小和 nginx
Range 206/1024/总大小/源前缀一致，不依赖公网缓存。

最终隔离回归使用冻结制品运行：共享 14 项及 Podsync 两消费者生命周期用例通过；
确证 native 缺盘 fixture 三次返回 False，未知 helper/I/O、写/清理未知、错误卷/只读、
预算/历史上限继续拒绝。最终实际暂停演练没有前一轮辅助探针的解释器错误。
未修改 Go 应用代码，因此未重复运行整套 Go 测试；文档/登记另做链接、JSON、敏感字段及 diff 检查。

实际配置、activation、state 哈希与平台 `current-release.json` 的 Podsync 子树对齐，
平台其他项目工作区内容保留。最终控制器发布和演练回执位于上述受限目录下
`controller-final-deployment/`、`final-lifecycle-exercise/result.json`、`verification-final80.json`。
本次已修复并部署可安全证明的缺盘/清洁排空/同卷重挂路径；无法确认的写入、清理或消费者
结局仍需审查。没有再次物理拔插生产盘，不能承诺所有中途 I/O 故障均可自动恢复，
也不把本轮结果称为硬件或旧 HTTP/TLS 根因已治愈。

23:04 最终自然运行核对：八轮 sequence 唯一连续且计数一致；22:29 后五轮共 140 次 feed
成功更新、下载/发布/上报各一次、errors 0，无重复发布组；最后一轮正常 running，
28 feed / 0 下载 / 0 发布 / errors 0，最新事件 23:02:42。
原失联轮次的 partial/28 errors 保留。成功 SELECT 均 rows_written 0。
22:29 后完整原 ID stdout 留存中 warning 10 均为既有 Bilibili discovery 不可用跳过，
error/fatal/panic 0，远端事件上传失败消息 0；不把这段恢复后窗口冒称整天日志。
23:05:37 诊断最终存量为应用 96 条/91,819 字节、恢复器 81 条/79,934 字节，
均仅两文件且 0600，敏感字段检查通过；已持久记录内 dropped/write_failures 快照仍为 0。
存量包含更早历史和预期状态转换，不能把其 failure 总数当作本轮新增业务失败。
