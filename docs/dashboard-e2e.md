# Dashboard E2E 测试

Cloudflare Worker dashboard 的 E2E 测试放在 `cloudflare/worker/test/e2e/`，使用 Playwright。

## 本地隔离测试

默认 E2E 测试只启动一个本地 HTTP server，并把请求转发给 Worker 的 `fetch`，数据存在 `fakeD1` 中。测试使用本地 RSA key、Access JWT 和 JWKS 响应验证真实的 JWT 鉴权链路；它不会访问线上 dashboard，也不会修改线上 D1/R2。

```bash
cd cloudflare/worker
npm run e2e
```

覆盖范围包括：

- 新增、停用、启用、删除订阅源。
- 编辑订阅源配置，并校验 RSS、OPML、NAS TOML 导出。
- 隐藏、恢复、删除剧集，并校验 RSS 和 tombstone。
- 取消/确认危险删除操作。
- 筛选、排序、日志 modal、移动端剧集入口。
- Access JWT 可访问 dashboard/Admin API，同时 NAS API、`/health` 和 RSS 路由不受影响。

## 线上只读 smoke

线上 smoke 默认跳过。只有显式提供线上地址和 dashboard 鉴权信息时才会运行，并且只做读取和 UI 展示检查，不会新增、编辑、停用或删除任何数据。

```bash
cd cloudflare/worker
PODSYNC_E2E_ONLINE_BASE_URL=https://podsync.kyangc.net \
PODSYNC_E2E_COOKIE='CF_Authorization=...' \
npm run e2e:online
```

也可以使用 Cloudflare Access JWT：

```bash
PODSYNC_E2E_ONLINE_BASE_URL=https://podsync.kyangc.net \
PODSYNC_E2E_CF_ACCESS_JWT='...' \
npm run e2e:online
```

线上 smoke 会检查 dashboard 页面、日志 modal、订阅源详情、剧集列表、订阅导出接口，以及第一条 OPML/RSS 是否可读。
