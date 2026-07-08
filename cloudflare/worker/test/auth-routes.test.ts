import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1 } from "./fake-d1";

const env = {
  DB: fakeD1({
    tomlFeeds: [],
    youtubeDefaults: { socket_timeout: 12, retries: 1, fragment_retries: 1 },
  }),
  NAS_TOKEN: "secret-token",
};

const envWithAdminToken = {
  ...env,
  ADMIN_TOKEN: "admin-token",
};

describe("route auth boundaries", () => {
  it("rejects NAS config without token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/api/nas/config.toml"), env);

    expect(response.status).toBe(401);
  });

  it("rejects NAS config with wrong token", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/config.toml", {
        headers: { authorization: "Bearer wrong" },
      }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("allows NAS config with correct token", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/config.toml", {
        headers: { authorization: "Bearer secret-token" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/toml");
  });

  it("requires GET for NAS config", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/api/nas/config.toml", {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
      }),
      env,
    );

    expect(response.status).toBe(405);
  });

  it("guards admin routes with Cloudflare Access identity", async () => {
    const withoutAccess = await worker.fetch(new Request("https://podcast.example.com/api/admin/feeds"), env);
    expect(withoutAccess.status).toBe(403);

    const withAccess = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(withAccess.status).not.toBe(403);
  });

  it("ignores spoofed Cloudflare Access headers when ADMIN_TOKEN is configured", async () => {
    const spoofedAccess = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      envWithAdminToken,
    );
    expect(spoofedAccess.status).toBe(403);

    const withToken = await worker.fetch(
      new Request("https://podcast.example.com/api/admin/feeds", {
        headers: { authorization: "Bearer admin-token" },
      }),
      envWithAdminToken,
    );
    expect(withToken.status).toBe(200);
  });

  it("guards dashboard routes with Cloudflare Access identity", async () => {
    const withoutAccess = await worker.fetch(new Request("https://podcast.example.com/dashboard/"), env);
    expect(withoutAccess.status).toBe(403);

    const withAccess = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(withAccess.status).toBe(200);
  });

  it("sets a dashboard admin cookie from a valid token query", async () => {
    const login = await worker.fetch(new Request("https://podcast.example.com/dashboard/?token=admin-token"), envWithAdminToken);

    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/dashboard/");
    expect(login.headers.get("set-cookie")).toContain("podsync_admin_token=admin-token");

    const dashboard = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        headers: { cookie: "podsync_admin_token=admin-token" },
      }),
      envWithAdminToken,
    );
    expect(dashboard.status).toBe(200);
  });

  it("rejects invalid dashboard admin token queries", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/dashboard/?token=wrong"), envWithAdminToken);

    expect(response.status).toBe(403);
  });

  it("guards nested dashboard routes with the same Access and method boundaries", async () => {
    const withoutAccess = await worker.fetch(new Request("https://podcast.example.com/dashboard/settings"), env);
    expect(withoutAccess.status).toBe(403);

    const wrongMethod = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/settings", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(wrongMethod.status).toBe(405);

    const withAccess = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/settings", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );
    expect(withAccess.status).toBe(200);
  });

  it("requires GET for dashboard routes", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );

    expect(response.status).toBe(405);
  });

  it("serves the dashboard management shell with defensive headers", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.text();
    expect(body).toContain("data-dashboard-app");
    expect(body).toContain("Podsync Dashboard");
    expect(body).toContain("PodSync 远端管理");
    expect(body).toContain("添加订阅源");
    expect(body).toContain("剧集列表");
    expect(body).toContain("运行日志");
    expect(body).not.toContain("id=\"logs-close\"");
    expect(body).toContain(".modal.logs { width: min(820px, 100%); }");
    expect(body).toContain(".modal.logs .table-wrap table { min-width: 760px; }");
    expect(body).toContain(".modal.logs th, .modal.logs td");
    expect(body).toContain("white-space: nowrap;");
    expect(body).toContain("<tr><th style=\"width: 22%\">时间</th><th style=\"width: 10%\">等级</th><th style=\"width: 24%\">来源</th><th style=\"width: 44%\">消息</th></tr>");
    expect(body).toContain("id=\"feed-details-modal\"");
    expect(body).toContain("id=\"feed-details-body\"");
    expect(body).toContain("id=\"confirm-modal\"");
    expect(body).toContain("id=\"toast-region\"");
    expect(body).toContain("data-region=\"feeds\"");
    expect(body).toContain("data-region=\"episodes\"");
    expect(body).toContain("data-region=\"subscriptions\"");
    expect(body).toContain("data-region=\"runs\"");
    expect(body).toContain("data-region=\"events\"");
    expect(body).toContain("data-select-control=\"provider-filter\"");
    expect(body).toContain("id=\"provider-filter-menu\"");
    expect(body).toContain("data-select-control=\"feed-provider\"");
    expect(body).toContain("id=\"feed-provider-menu\"");
    expect(body).toContain("data-select-control=\"episode-status-filter\"");
    expect(body).toContain("id=\"episode-status-filter-menu\"");
    expect(body).toContain("data-select-control=\"event-level-filter\"");
    expect(body).toContain("id=\"event-level-filter-menu\"");
    expect(body).toContain("function setupCustomSelect");
    expect(body).toContain("function closeCustomSelects");
    expect(body).toContain("function closeModalFromBackdrop");
    expect(body).toContain("if (event.target !== event.currentTarget) return;");
    expect(body).toContain("document.querySelectorAll(\".modal-backdrop\")");
    expect(body).toContain("backdrop.addEventListener(\"click\", closeModalFromBackdrop)");
    expect(body).toContain("/api/admin/feeds");
    expect(body).toContain("/api/admin/subscriptions");
    expect(body).toContain("/api/admin/episodes");
    expect(body).toContain("/api/admin/feeds/upsert");
    expect(body).toContain("/api/admin/feeds/status");
    expect(body).toContain("/api/admin/feeds/delete");
    expect(body).toContain("/api/admin/episodes/status");
    expect(body).toContain("/api/admin/sync-runs?limit=10");
    expect(body).toContain("/api/admin/events?limit=25");
    expect(body).toContain("data-feed-form");
    expect(body).toContain("function openNewFeedForm");
    expect(body).toContain("function openEditFeedForm");
    expect(body).toContain("function openFeedDetailsModal");
    expect(body).toContain("function renderFeedDetails");
    expect(body).toContain("class=\"tooltip-label\"");
    expect(body).toContain(".form-section[hidden] { display: none; }");
    expect(body).toContain("id=\"metric-health-card\"");
    expect(body).toContain("id=\"metric-health\">");
    expect(body).toContain("id=\"metric-logs\">");
    expect(body).toContain("sync-button");
    expect(body).toContain("sync-icon");
    expect(body).toContain(".sync-icon svg");
    expect(body).toContain("<svg viewBox=\"0 0 24 24\" focusable=\"false\"><path d=\"M4 9V4h5\"></path>");
    expect(body).toContain(".pill.provider-bilibili");
    expect(body).toContain(".pill.provider-youtube");
    expect(body).toContain("function providerPillClass");
    expect(body).toContain("button.primary:hover:not(:disabled) { background: #1d4ed8; border-color: #1d4ed8; color: #ffffff; }");
    expect(body).toContain("button.sync-button {");
    expect(body).toContain("button.sync-button:hover:not(:disabled) { border-color: #bfdbfe; background: #eff6ff; color: var(--accent); }");
    expect(body).toContain("订阅导出");
    expect(body).toContain("OPML");
    expect(body).toContain(".summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(body).toContain("<th style=\"width: 32%\">订阅源</th>");
    expect(body).toContain("<th style=\"width: 17%\">操作</th>");
    expect(body).toContain(".metric[data-tooltip]::after");
    expect(body).toContain("#metric-logs { color: var(--text); }");
    expect(body).toContain("#metric-health { font-size: 15px; }");
    expect(body).toContain("#metric-health.metric-health-ok");
    expect(body).toContain("#metric-health.metric-health-warning");
    expect(body).toContain("health.className = recentFailures > 0 ? \"metric-health-warning\" : \"metric-health-ok\"");
    expect(body).toContain("byID(\"metric-health-card\").setAttribute(\"data-tooltip\", healthTooltip)");
    expect(body).toContain("toolbar-left feed-filter-bar");
    expect(body).toContain("justify-content: flex-start");
    expect(body).toContain("button.ghost:hover:not(:disabled), button.link-button:hover:not(:disabled)");
    expect(body).toContain(".feed-title-button:hover:not(:disabled)");
    expect(body).toContain("tbody tr.selected { background: #ffffff; }");
    expect(body).toContain("tbody tr.disabled-row { color: var(--text); background: #ffffff; }");
    expect(body).toContain(".icon-button[data-tooltip]:hover::after");
    expect(body).toContain("display: none;\n      pointer-events: none;\n      transform: translate(-50%, 2px);");
    expect(body).toContain("display: block;");
    expect(body).not.toContain("transition: opacity 120ms ease, transform 120ms ease;\n    }\n    .icon-button[data-tooltip]:hover::after");
    expect(body).toContain(".feed-filter-bar .custom-select");
    expect(body).toContain(".form-field .custom-select");
    expect(body).toContain(".modal-toolbar .custom-select");
    expect(body).toContain(".form-field.checkbox-field");
    expect(body).toContain("基础信息");
    expect(body).toContain("发布设置");
    expect(body).toContain("展示覆盖");
    expect(body).toContain("抓取参数");
    expect(body).toContain("过滤规则");
    expect(body).toContain("id=\"feed-bilibili-options\"");
    expect(body).toContain("byID(\"feed-bilibili-options\").hidden = !isBilibili");
    expect(body).not.toContain("发布与 B 站选项");
    expect(body).not.toContain("class=\"check-row\"");
    expect(body).toContain("trigger.disabled = select.disabled");
    expect(body).toContain("classList.toggle(\"is-disabled\", select.disabled)");
    expect(body).toContain("#reset-feed-filters");
    expect(body).toContain("flex: 0 0 auto");
    expect(body).toContain(".summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }");
    expect(body).toContain("top: 50%");
    expect(body).toContain("transform: translateY(-60%) rotate(45deg)");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("@media (max-width: 720px)");
    expect(body).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto");
    expect(body).toContain("@media (max-width: 360px)");
    expect(body).toContain("grid-column: 1 / -1");
    expect(body).toContain("section[data-region=\"feeds\"] tbody tr");
    expect(body).toContain("cell.setAttribute(\"data-label\", label)");
    expect(body).toContain(".icon-button[data-tooltip]::after");
    expect(body).toContain(".icon-button:disabled { opacity: 1; }");
    expect(body).toContain(".icon-button:disabled svg { opacity: 0.45; }");
    expect(body).toContain(".icon-button.mobile-only { display: none; }");
    expect(body).toContain("button.setAttribute(\"data-tooltip\", label)");
    expect(body).toContain("byID(\"metric-logs\").textContent = String(state.events.length)");
    expect(body).toContain("appendCell(row, nameStack, \"\", \"订阅源\")");
    expect(body).toContain("var mobileMeta = el(\"div\", \"mobile-feed-meta\")");
    expect(body).toContain("mobileMeta.appendChild(el(\"span\", providerPillClass(feed.provider), provider))");
    expect(body).toContain("appendCell(row, el(\"span\", providerPillClass(feed.provider), provider), \"provider-cell\", \"平台\")");
    expect(body).toContain("chips.appendChild(el(\"span\", providerPillClass(feed.provider), providerLabel(feed.provider)))");
    expect(body).toContain("appendCell(row, lastActivity, \"activity-cell\", \"最近活动\")");
    expect(body).toContain("appendCell(row, episodes, \"episodes-cell\", \"剧集\")");
    expect(body).toContain("appendCell(row, copy, \"subscription-cell\", \"订阅\")");
    expect(body).toContain("iconButton(\"list mobile-only\", \"查看剧集\", \"list\")");
    expect(body).toContain("iconButton(\"copy mobile-only\", \"复制订阅地址\", \"copy\")");
    expect(body).toContain("iconButton(feed.enabled ? \"pause\" : \"play\", feed.enabled ? \"停用订阅源\" : \"启用订阅源\"");
    expect(body).toContain("iconButton(\"edit\", \"编辑订阅源\", \"edit\")");
    expect(body).toContain("iconButton(\"delete\", \"删除订阅源\", \"delete\")");
    expect(body).toContain("var changed = state.busy !== value");
    expect(body).toContain("if (changed && !value)");
    expect(body).toContain("renderFeeds();\n          renderEpisodes();");
    expect(body).toContain("section[data-region=\"feeds\"] tbody td::before");
    expect(body).toContain("section[data-region=\"feeds\"] .mobile-feed-meta");
    expect(body).toContain("section[data-region=\"feeds\"] .episodes-cell");
    expect(body).toContain("section[data-region=\"feeds\"] .actions-cell .mobile-only");
    expect(body).toContain("section[data-region=\"episodes\"].modal");
    expect(body).toContain("section[data-region=\"episodes\"] tbody tr");
    expect(body).toContain("section[data-region=\"episodes\"] .episode-title-cell");
    expect(body).toContain("section[data-region=\"episodes\"] .episode-status-cell");
    expect(body).toContain("section[data-region=\"episodes\"] .modal-footer");
    expect(body).toContain("appendCell(row, actions, \"actions-cell\", \"操作\")");
    expect(body).toContain("appendCell(row, titleNode, \"episode-title-cell\", \"剧集\")");
    expect(body).toContain("appendCell(row, formatDate(episode.published_at || episode.updated_at), \"episode-published-cell\", \"发布\")");
    expect(body).toContain("appendCell(row, episodeActions(episode), \"actions-cell\", \"操作\")");
    expect(body).toContain("data-tooltip=\"远端配置里的唯一标识");
    expect(body).toContain("data-tooltip=\"NAS 拉取配置后按这个间隔尝试更新");
    expect(body).not.toContain(" title=\"");
    expect(body).toContain("id=\"feed-id-error\"");
    expect(body).toContain("id=\"feed-update-period-error\"");
    expect(body).toContain("id=\"feed-page-size-error\"");
    expect(body).toContain("aria-required=\"true\"");
    expect(body).toContain(".form-field.has-error input");
    expect(body).toContain("function validateFeedFormRequiredFields");
    expect(body).toContain("!/^[0-9]+$/.test(raw)");
    expect(body).toContain("if (!validateFeedFormRequiredFields())");
    expect(body).toContain("showError(\"请先填写必填项\")");
    expect(body).toContain("function submitFeedForm");
    expect(body).toContain("function readFeedFormValues");
    expect(body).toContain("function deleteFeed");
    expect(body).toContain("function performDeleteFeed");
    expect(body).toContain("function openConfirmDialog");
    expect(body).toContain("function updateEpisodeStatus");
    expect(body).toContain("function copyLogs");
    expect(body).toContain("openConfirmDialog({");
    expect(body).toContain("performDeleteFeed(feedID)");
    expect(body).toContain("不会删除 NAS 本地文件");
    expect(body).toContain("postJSON(paths.feedDelete, { feed_id: feedID })");
    expect(body).toContain("state.selectedFeedID = \"\"");
    expect(body).toContain("await loadDashboard()");
    expect(body).toContain("showError(error)");
    expect(body).toContain("postJSON(paths.feedUpsert, payload)");
    expect(body).toContain("feedID = state.editingFeedID");
    expect(body).toContain("provider = original.provider");
    expect(body).toContain("openFeedDetailsModal(feed.feed_id)");
    expect(body).toContain("openEpisodesModal(feed.feed_id)");
    expect(body).toContain("function safeExternalURL");
    expect(body).toContain("url.protocol === \"http:\" || url.protocol === \"https:\"");
    expect(body).toContain("noopener noreferrer");
    expect(body.length).toBeGreaterThan(12000);
  });

  it("serves dashboard feed form fields and full upsert payload markers", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );

    const body = await response.text();
    const fieldIDs = [
      "feed-id",
      "feed-provider",
      "feed-url",
      "feed-title-override",
      "feed-description-override",
      "feed-enabled",
      "feed-include-in-opml",
      "feed-private-feed",
      "feed-update-period",
      "feed-page-size",
      "feed-keep-last",
      "feed-cookie-profile",
      "feed-bilibili-include-upower",
      "feed-filter-title",
      "feed-filter-not-title",
      "feed-filter-description",
      "feed-filter-not-description",
      "feed-filter-min-duration",
      "feed-filter-max-duration",
      "feed-filter-min-age",
      "feed-filter-max-age",
    ];
    for (const id of fieldIDs) {
      expect(body).toContain(`id="${id}"`);
    }
    expect(body).toContain("placeholder=\"例如 bilibili-10835521 或 youtube-maker\"");
    expect(body).toContain("placeholder=\"例如 影视飓风精选\"");
    expect(body).toContain("placeholder=\"默认 1h，例如 30m、2h\"");
    expect(body).toContain("placeholder=\"默认 25，0 表示不限制\"");
    expect(body).toContain("placeholder=\"天，例如 90\"");
    expect(body).toContain("最短发布天数");
    expect(body).toContain("最长发布天数");
    expect(body).not.toContain(">最小年龄</label>");
    expect(body).not.toContain(">最大年龄</label>");
    expect(body).toContain("byID(\"feed-danger-zone\").hidden = !editing");

    const payloadKeys = [
      "feed_id:",
      "provider:",
      "url:",
      "title_override:",
      "description_override:",
      "enabled:",
      "include_in_opml:",
      "private_feed:",
      "update_period:",
      "page_size:",
      "keep_last:",
      "cookie_profile:",
      "bilibili:",
      "filters:",
    ];
    for (const key of payloadKeys) {
      expect(body).toContain(key);
    }

    const filterKeys = [
      "title: textOrNull(\"feed-filter-title\")",
      "not_title: textOrNull(\"feed-filter-not-title\")",
      "description: textOrNull(\"feed-filter-description\")",
      "not_description: textOrNull(\"feed-filter-not-description\")",
      "min_duration: optionalInteger(\"feed-filter-min-duration\", \"最小时长\")",
      "max_duration: optionalInteger(\"feed-filter-max-duration\", \"最大时长\")",
      "min_age: optionalInteger(\"feed-filter-min-age\", \"最短发布天数\")",
      "max_age: optionalInteger(\"feed-filter-max-age\", \"最长发布天数\")",
    ];
    for (const key of filterKeys) {
      expect(body).toContain(key);
    }
  });

  it("keeps dashboard source free of unsafe DOM shortcuts and external assets", async () => {
    const response = await worker.fetch(
      new Request("https://podcast.example.com/dashboard/", {
        headers: { "cf-access-jwt-assertion": "present" },
      }),
      env,
    );

    const body = await response.text();
    const lower = body.toLowerCase();
    expect(body).not.toContain(".innerHTML");
    expect(body).not.toContain("insertAdjacentHTML");
    expect(lower).not.toContain("<script src=");
    expect(lower).not.toContain("<link rel=\"stylesheet\"");
    expect(lower).not.toContain("<link rel='stylesheet'");
    expect(body).not.toContain("/api/nas/");
    expect(body).not.toContain("http://");
    expect(body).not.toContain("https://");
  });
});
