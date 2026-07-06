import { hasCloudflareAccessIdentity, isAuthorizedNasRequest } from "./auth";
import type { DownloaderDefaults, EpisodeStatusRow, EpisodeUpsertRequest, FeedTomlRow, PublicEpisodeRow, PublicFeedRow } from "./db";
import type { Env } from "./env";
import { sha256Hex } from "./tokens";
import { compileFeedsToml } from "./toml";
import { InvalidMediaBaseURLError, InvalidR2KeyError, renderRss, renderOpml, validateR2Key } from "./xml";

const defaultYoutubeDefaults: DownloaderDefaults = {
	socket_timeout: 12,
	retries: 1,
	fragment_retries: 1,
};
const maxJsonBodyBytes = 64 * 1024;

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function pathToken(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".xml")) return null;
  const token = pathname.slice(prefix.length, -".xml".length);
  if (token === "") return null;
  try {
    return decodeURIComponent(token);
  } catch {
    return null;
  }
}

function methodNotAllowed(): Response {
	return text("method not allowed", 405);
}

function badRequest(message: string): Response {
	return text(message, 400);
}

function isJsonContentType(request: Request): boolean {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

async function readBoundedText(request: Request, limit: number): Promise<string | null> {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isProvider(value: unknown): value is EpisodeUpsertRequest["provider"] {
	return value === "youtube" || value === "bilibili";
}

function parseEpisodeUpsert(body: unknown): EpisodeUpsertRequest | Response {
	if (!body || typeof body !== "object") return badRequest("invalid episode body");
	const value = body as Record<string, unknown>;
	if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
	if (!isProvider(value.provider)) return badRequest("provider is invalid");
	if (!nonEmptyString(value.source_episode_id)) return badRequest("source_episode_id is required");
	if (!nonEmptyString(value.local_episode_id)) return badRequest("local_episode_id is required");
	if (!nonEmptyString(value.r2_key)) return badRequest("r2_key is required");
	try {
		validateR2Key(value.r2_key);
	} catch (error) {
		if (error instanceof InvalidR2KeyError) return badRequest("r2_key is invalid");
		throw error;
	}
	if (!nonEmptyString(value.mime_type)) return badRequest("mime_type is required");
	if (!nonEmptyString(value.asset_token)) return badRequest("asset_token is required");
	if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) {
		return badRequest("size is invalid");
	}
	if (value.duration !== undefined && (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0)) {
		return badRequest("duration is invalid");
	}
	if (value.published_at !== undefined) {
		if (!nonEmptyString(value.published_at) || Number.isNaN(Date.parse(value.published_at))) {
			return badRequest("published_at is invalid");
		}
	}

	const request: EpisodeUpsertRequest = {
		feed_id: value.feed_id,
		provider: value.provider,
		source_episode_id: value.source_episode_id,
		local_episode_id: value.local_episode_id,
		r2_key: value.r2_key,
		size: value.size,
		mime_type: value.mime_type,
		asset_token: value.asset_token,
	};
	const sourceURL = optionalString(value.source_url);
	if (sourceURL !== undefined) request.source_url = sourceURL;
	const thumbnail = optionalString(value.thumbnail);
	if (thumbnail !== undefined) request.thumbnail = thumbnail;
	const title = optionalString(value.title);
	if (title !== undefined) request.title = title;
	const description = optionalString(value.description);
	if (description !== undefined) request.description = description;
	const publishedAt = optionalString(value.published_at);
	if (publishedAt !== undefined) request.published_at = publishedAt;
	if (value.duration !== undefined) request.duration = value.duration as number;
	return request;
}

async function handleNasConfig(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }

  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.enabled,
            f.include_in_opml, f.private_feed, f.update_period, f.page_size, f.keep_last,
            f.cookie_profile, f.feed_token_hash, ff.title, ff.not_title, ff.description,
            ff.not_description, ff.min_duration, ff.max_duration, ff.min_age, ff.max_age
       FROM feeds f
       LEFT JOIN feed_filters ff ON ff.feed_id = f.feed_id
      WHERE f.enabled = 1
      ORDER BY f.feed_id ASC`,
  ).all<FeedTomlRow>();

  const defaults = await env.DB.prepare(
    `SELECT socket_timeout, retries, fragment_retries
       FROM global_downloader_defaults
      WHERE provider = 'youtube'`,
  ).first<DownloaderDefaults>();

  const toml = compileFeedsToml(results, defaults ?? defaultYoutubeDefaults);
  return text(toml, 200, "application/toml; charset=utf-8");
}

async function handleEpisodeUpsert(request: Request, env: Env): Promise<Response> {
	if (!(await isAuthorizedNasRequest(request, env))) {
		return text("unauthorized", 401);
	}
	if (!isJsonContentType(request)) {
		return badRequest("content-type must be application/json");
	}

	const bodyText = await readBoundedText(request, maxJsonBodyBytes);
	if (bodyText === null) {
		return badRequest("request body too large");
	}

	let rawBody: unknown;
	try {
		rawBody = JSON.parse(bodyText);
	} catch {
		return badRequest("invalid json");
	}

	const parsed = parseEpisodeUpsert(rawBody);
	if (parsed instanceof Response) return parsed;

	const feed = await env.DB.prepare(
		`SELECT feed_id, provider
		   FROM feeds
		  WHERE feed_id = ?`,
	).bind(parsed.feed_id).first<{ feed_id: string; provider: EpisodeUpsertRequest["provider"] }>();

	if (!feed) return text("feed not found", 404);
	if (feed.provider !== parsed.provider) return badRequest("provider mismatch");

	await env.DB.prepare(
		`INSERT INTO episodes (
		    feed_id, provider, source_episode_id, local_episode_id, source_url, thumbnail,
		    title, description, published_at, duration, status, r2_key, size, mime_type,
		    asset_token, created_at, updated_at
		  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		  ON CONFLICT(feed_id, local_episode_id) DO UPDATE SET
		    provider = excluded.provider,
		    source_episode_id = excluded.source_episode_id,
		    source_url = excluded.source_url,
		    thumbnail = excluded.thumbnail,
		    title = excluded.title,
		    description = excluded.description,
		    published_at = excluded.published_at,
		    duration = excluded.duration,
		    status = CASE
		      WHEN episodes.status IN ('pending', 'visible') THEN 'visible'
		      ELSE episodes.status
		    END,
		    r2_key = excluded.r2_key,
		    size = excluded.size,
		    mime_type = excluded.mime_type,
		    asset_token = excluded.asset_token,
		    updated_at = CURRENT_TIMESTAMP`,
	).bind(
		parsed.feed_id,
		parsed.provider,
		parsed.source_episode_id,
		parsed.local_episode_id,
		parsed.source_url ?? null,
		parsed.thumbnail ?? null,
		parsed.title ?? null,
		parsed.description ?? null,
		parsed.published_at ?? null,
		parsed.duration ?? null,
		parsed.r2_key,
		parsed.size,
		parsed.mime_type,
		parsed.asset_token,
	).run();

	const status = await env.DB.prepare(
		`SELECT status
		   FROM episodes
		  WHERE feed_id = ? AND local_episode_id = ?`,
	).bind(parsed.feed_id, parsed.local_episode_id).first<EpisodeStatusRow>();

	return Response.json({
		ok: true,
		feed_id: parsed.feed_id,
		local_episode_id: parsed.local_episode_id,
		status: status?.status ?? "visible",
	});
}

async function handleFeedXml(pathname: string, request: Request, env: Env): Promise<Response> {
  const token = pathToken(pathname, "/f/");
  if (!token) return text("not found", 404);

  const tokenHash = await sha256Hex(token);
  const feed = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.page_size,
            m.title, m.description, m.link
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.enabled = 1 AND f.feed_token_hash = ?`,
  ).bind(tokenHash).first<PublicFeedRow>();

  if (!feed) return text("not found", 404);

  const limit = feed.page_size > 0 ? feed.page_size : 25;
  const { results: episodes } = await env.DB.prepare(
    `SELECT local_episode_id, source_url, title, description, published_at, duration,
            r2_key, size, mime_type
       FROM episodes
      WHERE feed_id = ?
        AND status = 'visible'
        AND r2_key IS NOT NULL
      ORDER BY COALESCE(published_at, updated_at) DESC
      LIMIT ?`,
  ).bind(feed.feed_id, limit).all<PublicEpisodeRow>();

  try {
    return text(
      renderRss({
      title: feed.title ?? feed.title_override ?? feed.feed_id,
      link: feed.link ?? feed.url ?? new URL(request.url).origin,
      description: feed.description ?? feed.description_override ?? "Podsync feed",
      }, episodes, { mediaBaseURL: episodes.length > 0 ? env.MEDIA_PUBLIC_BASE_URL : undefined }),
      200,
      "application/rss+xml; charset=utf-8",
    );
  } catch (error) {
    if (error instanceof InvalidMediaBaseURLError) {
      return text(error.message, 500);
    }
    if (error instanceof InvalidR2KeyError) {
      return text(error.message, 500);
    }
    throw error;
  }
}

async function handleOpml(pathname: string, env: Env): Promise<Response> {
  const token = pathToken(pathname, "/opml/");
  if (!token) return text("not found", 404);

  const tokenHash = await sha256Hex(token);
  const opmlToken = await env.DB.prepare(
    `SELECT id
       FROM opml_tokens
      WHERE enabled = 1 AND token_hash = ?`,
  ).bind(tokenHash).first<{ id: number }>();

  if (!opmlToken) return text("not found", 404);

  return text(renderOpml([]), 200, "text/x-opml; charset=utf-8");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return methodNotAllowed();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/nas/config.toml") {
      if (request.method !== "GET") return methodNotAllowed();
      return handleNasConfig(request, env);
    }

    if (url.pathname === "/api/nas/episodes/upsert") {
      if (request.method !== "POST") return methodNotAllowed();
      return handleEpisodeUpsert(request, env);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
      return text("not found", 404);
    }

    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      if (request.method !== "GET") return methodNotAllowed();
      if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
      return text("<!doctype html><title>Podsync</title>", 200, "text/html; charset=utf-8");
    }

    if (url.pathname.startsWith("/f/")) {
      if (request.method !== "GET") return methodNotAllowed();
      return handleFeedXml(url.pathname, request, env);
    }

    if (url.pathname.startsWith("/opml/")) {
      if (request.method !== "GET") return methodNotAllowed();
      return handleOpml(url.pathname, env);
    }

    return text("not found", 404);
  },
};
