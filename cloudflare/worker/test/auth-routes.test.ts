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
});
