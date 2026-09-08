# Podsync 开发规则

- 保留 `github.com/mxpv/podsync` module path，避免无关的 upstream 差异。
- 修改 Bilibili 行为时同时考虑 discovery 和下载；源 cookies 文件不得被回写污染。
- 文件名迁移和清理会影响既有媒体；仅在任务已授权时执行。S3 文件名迁移只支持 dry-run。
- 结构、配置、生命周期或运行问题按需查 [维护参考](docs/agent-maintenance-reference.md) 的对应章节。

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

- “take a look” 按只读审查处理；“fix” 授权范围内完成修复和相关验证。
- 发布 PR 或 Issue 评论复用任务中已有授权；审查请求本身不授权外部写入。
- 缺少必要信息或无法继续时，报告具体阻塞。
