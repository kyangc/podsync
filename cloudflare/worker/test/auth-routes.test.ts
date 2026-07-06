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
    expect(body).toContain("/api/admin/feeds/status");
    expect(body).toContain("/api/admin/episodes/status");
    expect(body).toContain("/api/admin/sync-runs?limit=10");
    expect(body).toContain("/api/admin/events?limit=25");
    expect(body).toContain("function safeExternalURL");
    expect(body).toContain("url.protocol === \"http:\" || url.protocol === \"https:\"");
    expect(body).toContain("noopener noreferrer");
    expect(body.length).toBeGreaterThan(12000);
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
