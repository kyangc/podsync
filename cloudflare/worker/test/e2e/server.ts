import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { sha256Hex } from "../../src/tokens";
import { accessAssertion, accessEnv, accessJwks, accessJwksURL, requestURL } from "../access";
import { fakeD1 } from "../fake-d1";

const nasToken = "secret";
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = requestURL(input);
  if (url === accessJwksURL) return Response.json(accessJwks);
  return originalFetch(input, init);
};

export interface E2EServer {
  url: string;
  close(): Promise<void>;
}

export interface E2EServerOptions {
  injectAccessHeader?: boolean | undefined;
}

export async function startE2EServer(options: E2EServerOptions = {}): Promise<E2EServer> {
  const opmlTokenHash = await sha256Hex("e2e-opml");
  const env: Env = {
    ...accessEnv,
    DB: fakeD1({
      feedsByID: new Map(),
      episodesByKey: new Map(),
      opmlTokenHashes: new Set([opmlTokenHash]),
      opmlTokensByHash: new Map([
        [opmlTokenHash, { label: "Default", public_path: "/opml/e2e-opml.xml" }],
      ]),
    }),
    MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
    NAS_TOKEN: nasToken,
  };
  const server = createServer((request, response) => {
    handleRequest(request, response, env, options).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.stack : String(error));
    });
  });
  await listen(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => close(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: Env,
  options: E2EServerOptions,
): Promise<void> {
  const origin = `http://${request.headers.host}`;
  const url = new URL(request.url ?? "/", origin);

  if (url.pathname === "/__test/seed-episode") {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }
    const body = await readJSON(request);
    const seed = await worker.fetch(nasJSONRequest(origin, "/api/nas/episodes/upsert", episodeBody(body)), env);
    await forwardResponse(seed, response);
    return;
  }

  if (url.pathname === "/__test/seed-events") {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }
    const body = await readJSON(request);
    const seed = await worker.fetch(nasJSONRequest(origin, "/api/nas/events/batch", eventBatchBody(body)), env);
    await forwardResponse(seed, response);
    return;
  }

  if (url.pathname === "/__test/seed-feed-metadata") {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }
    const body = await readJSON(request);
    const seed = await worker.fetch(nasJSONRequest(origin, "/api/nas/feed-metadata/upsert", feedMetadataBody(body)), env);
    await forwardResponse(seed, response);
    return;
  }

  if (url.pathname === "/__test/config.toml") {
    const config = await worker.fetch(new Request(`${origin}/api/nas/config.toml`, {
      headers: { authorization: `Bearer ${nasToken}` },
    }), env);
    await forwardResponse(config, response);
    return;
  }

  if (url.pathname === "/__test/tombstones") {
    const tombstones = await worker.fetch(new Request(`${origin}/api/nas/tombstones${url.search}`, {
      headers: { authorization: `Bearer ${nasToken}` },
    }), env);
    await forwardResponse(tombstones, response);
    return;
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (options.injectAccessHeader !== false) headers.set("cf-access-jwt-assertion", accessAssertion);

  const workerRequestInit: RequestInit = {
    method: request.method ?? "GET",
    headers,
  };
  if (body !== undefined) workerRequestInit.body = body;

  const workerRequest = new Request(url, workerRequestInit);
  const workerResponse = await worker.fetch(workerRequest, env);
  await forwardResponse(workerResponse, response);
}

function nasJSONRequest(origin: string, path: string, body: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${nasToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function episodeBody(overrides: Record<string, unknown>) {
  return {
    feed_id: "ui-e2e-feed",
    provider: "youtube",
    source_episode_id: "video-1",
    local_episode_id: "video-1",
    source_url: "https://www.youtube.com/watch?v=video-1",
    thumbnail: "https://img.example.com/video-1.jpg",
    title: "UI E2E Episode",
    description: "Episode from browser e2e",
    published_at: "2026-07-08T12:00:00Z",
    duration: 123,
    r2_key: "audio/ui-e2e-feed/video-1.mp3",
    size: 456,
    mime_type: "audio/mpeg",
    asset_token: "asset-token",
    ...overrides,
  };
}

function eventBatchBody(overrides: Record<string, unknown>) {
  return {
    run: {
      id: "ui-e2e-run",
      started_at: "2026-07-08T12:00:00Z",
      finished_at: "2026-07-08T12:05:00Z",
      status: "partial",
      feeds_updated: 1,
      episodes_downloaded: 1,
      episodes_uploaded: 1,
      errors_count: 1,
      ...(typeof overrides.run === "object" && overrides.run !== null ? overrides.run as Record<string, unknown> : {}),
    },
    events: Array.isArray(overrides.events) ? overrides.events : [
      {
        sequence: 1,
        event_time: "2026-07-08T12:03:00Z",
        level: "info",
        type: "feed_update_finished",
        feed_id: "alpha-notes",
        message: "YouTube updated",
      },
      {
        sequence: 2,
        event_time: "2026-07-08T12:02:00Z",
        level: "warn",
        type: "feed_update_failed",
        feed_id: "zed-bili",
        message: "Bilibili warning",
      },
      {
        sequence: 3,
        event_time: "2026-07-08T12:01:00Z",
        level: "error",
        type: "remote_api_failed",
        feed_id: "zed-bili",
        message: "Remote failed",
      },
    ],
  };
}

function feedMetadataBody(overrides: Record<string, unknown>) {
  return {
    feed_id: "ui-e2e-feed",
    provider: "youtube",
    source_url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
    title: "UI E2E Feed",
    description: "Feed metadata from browser e2e",
    image_url: "https://img.example.com/ui-e2e-feed.jpg",
    link: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
    author: "UI E2E",
    category: "Technology",
    language: "en",
    explicit: false,
    last_source_update_at: "2026-07-08T12:00:00Z",
    reported_at: "2026-07-08T12:05:00Z",
    ...overrides,
  };
}

async function readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (!body || body.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function forwardResponse(source: Response, target: ServerResponse): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, key) => {
    target.setHeader(key, value);
  });
  target.end(Buffer.from(await source.arrayBuffer()));
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
