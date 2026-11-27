import type { AdminEpisodeAction, EpisodeAdminRow } from "./db";
import type { Env } from "./env";
import { text } from "./validators";
import { validateR2Key } from "./xml";

export function r2KeyBlank(value: string | null): boolean {
  return value === null || value === "";
}

export function restoreRequiresMediaHead(action: AdminEpisodeAction, episode: EpisodeAdminRow): boolean {
  return action === "restore" && episode.status === "delete_pending" && !r2KeyBlank(episode.r2_key);
}

function encodeMediaKey(key: string): string {
  validateR2Key(key);
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function mediaOriginRequest(env: Env, key: string, method: "HEAD" | "DELETE"): Request | null {
  if (!env.MEDIA_ORIGIN_BASE_URL) return null;
  if (!env.NAS_TOKEN || !env.MEDIA_ORIGIN_ACCESS_CLIENT_ID || !env.MEDIA_ORIGIN_ACCESS_CLIENT_SECRET) {
    throw new Error("media origin credentials are incomplete");
  }
  const base = new URL(env.MEDIA_ORIGIN_BASE_URL);
  if (base.protocol !== "https:") throw new Error("media origin must use HTTPS");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  const url = new URL(encodeMediaKey(key), base);
  return new Request(url, {
    method,
    redirect: "manual",
    // A cacheable HEAD miss can become GET at Cloudflare's edge. Lifecycle
    // checks must reach the origin with their method and current object state.
    cache: "no-store",
    headers: {
      authorization: `Bearer ${env.NAS_TOKEN}`,
      "cf-access-client-id": env.MEDIA_ORIGIN_ACCESS_CLIENT_ID,
      "cf-access-client-secret": env.MEDIA_ORIGIN_ACCESS_CLIENT_SECRET,
    },
  });
}

export async function mediaObjectExists(env: Env, key: string): Promise<boolean> {
  const originRequest = mediaOriginRequest(env, key, "HEAD");
  if (originRequest) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        const request = attempt === 0 ? originRequest : mediaOriginRequest(env, key, "HEAD")!;
        response = await fetch(request);
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
      if (response.status === 404) return false;
      if (response.ok) return true;
      const retryable = response.status === 429 || response.status >= 500;
      if (attempt === 0 && retryable) {
        await response.body?.cancel();
        continue;
      }
      throw new Error(`media origin HEAD returned ${response.status}`);
    }
    throw new Error("media origin HEAD failed");
  }
  if (!env.MEDIA_BUCKET) throw new Error("media storage unavailable");
  return (await env.MEDIA_BUCKET.head(key)) !== null;
}

export async function deleteMediaObject(env: Env, key: string): Promise<void> {
  const originRequest = mediaOriginRequest(env, key, "DELETE");
  if (originRequest) {
    const response = await fetch(originRequest);
    if (!response.ok) throw new Error(`media origin DELETE returned ${response.status}`);
    return;
  }
  if (!env.MEDIA_BUCKET) throw new Error("media storage unavailable");
  await env.MEDIA_BUCKET.delete(key);
}

export async function verifyRestorableMediaObject(env: Env, action: AdminEpisodeAction, episode: EpisodeAdminRow): Promise<Response | null> {
  if (!restoreRequiresMediaHead(action, episode)) return null;
  try {
    if (!(await mediaObjectExists(env, episode.r2_key!))) return text("media object not found", 409);
  } catch {
    if (!env.MEDIA_ORIGIN_BASE_URL && !env.MEDIA_BUCKET) return text("media bucket unavailable", 503);
    return text("media object check failed", 502);
  }
  return null;
}

