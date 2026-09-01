import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1 } from "./fake-d1";

const originalFetch = globalThis.fetch;
const nasToken = "nas-token";

function request(body: unknown, token = nasToken): Request {
  return new Request("https://podcast.example.com/api/nas/media-origin/check", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function env() {
  return {
    DB: fakeD1(),
    NAS_TOKEN: nasToken,
    MEDIA_ORIGIN_BASE_URL: "https://podsync-media-admin.example/api/remote-media/",
    MEDIA_ORIGIN_ACCESS_CLIENT_ID: "client-id",
    MEDIA_ORIGIN_ACCESS_CLIENT_SECRET: "client-secret",
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NAS media origin check", () => {
  it("requires the NAS bearer token", async () => {
    const response = await worker.fetch(request({ r2_key: "audio/feed/episode.mp3" }, "wrong"), env());

    expect(response.status).toBe(401);
  });

  it("HEADs the Access-protected NAS origin without changing D1", async () => {
    let originRequest: Request | undefined;
    globalThis.fetch = async (input, init) => {
      originRequest = new Request(input, init);
      return new Response(null, { status: 204 });
    };

    const response = await worker.fetch(request({ r2_key: "audio/feed/episode.mp3" }), env());

    expect(response.status).toBe(204);
    expect(originRequest?.method).toBe("HEAD");
    expect(originRequest?.url).toBe("https://podsync-media-admin.example/api/remote-media/audio/feed/episode.mp3");
    expect(originRequest?.headers.get("authorization")).toBe(`Bearer ${nasToken}`);
    expect(originRequest?.headers.get("cf-access-client-id")).toBe("client-id");
    expect(originRequest?.headers.get("cf-access-client-secret")).toBe("client-secret");
  });

  it("returns not found when the NAS origin is missing the object", async () => {
    globalThis.fetch = async () => new Response(null, { status: 404 });

    const response = await worker.fetch(request({ r2_key: "audio/feed/missing.mp3" }), env());

    expect(response.status).toBe(404);
  });

  it("rejects invalid keys before calling the origin", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response(null, { status: 204 });
    };

    const response = await worker.fetch(request({ r2_key: "../unsafe.mp3" }), env());

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("requires the NAS origin to be configured", async () => {
    const response = await worker.fetch(request({ r2_key: "audio/feed/episode.mp3" }), {
      DB: fakeD1(),
      NAS_TOKEN: nasToken,
    });

    expect(response.status).toBe(503);
  });
});
