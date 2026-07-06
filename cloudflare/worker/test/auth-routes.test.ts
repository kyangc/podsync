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
    expect(body).toContain("data-region=\"feeds\"");
    expect(body).toContain("data-region=\"episodes\"");
    expect(body).toContain("data-region=\"subscriptions\"");
    expect(body).toContain("data-region=\"runs\"");
    expect(body).toContain("data-region=\"events\"");
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
    expect(body).toContain("function submitFeedForm");
    expect(body).toContain("function readFeedFormValues");
    expect(body).toContain("function deleteFeed");
    expect(body).toContain("el(\"button\", \"danger\", \"Delete\")");
    expect(body).toContain("window.confirm(\"Delete feed \" + feedID");
    expect(body).toContain("postJSON(paths.feedDelete, { feed_id: feedID })");
    expect(body).toContain("state.selectedFeedID = \"\"");
    expect(body).toContain("await loadDashboard()");
    expect(body).toContain("showError(error)");
    expect(body).toContain("postJSON(paths.feedUpsert, payload)");
    expect(body).toContain("feedID = state.editingFeedID");
    expect(body).toContain("provider = original.provider");
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
      "min_duration: optionalInteger(\"feed-filter-min-duration\", \"Min duration\")",
      "max_duration: optionalInteger(\"feed-filter-max-duration\", \"Max duration\")",
      "min_age: optionalInteger(\"feed-filter-min-age\", \"Min age\")",
      "max_age: optionalInteger(\"feed-filter-max-age\", \"Max age\")",
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
