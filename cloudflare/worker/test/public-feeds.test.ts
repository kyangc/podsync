import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/tokens";
import { fakeD1 } from "./fake-d1";

describe("public feed contracts", () => {
  it("serves an empty RSS feed for a valid feed token", async () => {
    const tokenHash = await sha256Hex("feed-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/f/feed-secret.xml"),
      {
        DB: fakeD1({
          publicFeedsByHash: new Map([
            [tokenHash, {
              feed_id: "bili",
              url: "https://space.bilibili.com/10835521",
              title_override: null,
              description_override: null,
              title: "Bilibili Feed",
              description: "A feed",
              link: "https://space.bilibili.com/10835521",
            }],
          ]),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/rss+xml");
    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain("<channel>");
    expect(body).toContain("<title>Bilibili Feed</title>");
    expect(body).not.toContain("<item>");
  });

  it("rejects an invalid feed token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/missing.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a malformed feed token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/%E0%A4%A.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("requires GET for public feed routes", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/f/feed-secret.xml", { method: "POST" }), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(405);
  });

  it("serves empty OPML for a valid OPML token", async () => {
    const tokenHash = await sha256Hex("opml-secret");
    const response = await worker.fetch(
      new Request("https://podcast.example.com/opml/opml-secret.xml"),
      {
        DB: fakeD1({
          opmlTokenHashes: new Set([tokenHash]),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-opml");
    const body = await response.text();
    expect(body).toContain('<opml version="2.0">');
    expect(body).toContain("<body>");
  });

  it("rejects an invalid OPML token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/missing.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a malformed OPML token", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/%E0%A4%A.xml"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(404);
  });

  it("requires GET for OPML routes", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/opml/opml-secret.xml", { method: "POST" }), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(405);
  });
});
