import { isAuthorizedAdminRequest, isAuthorizedNasRequest } from "./auth";
import { dashboardResponse } from "./dashboard";
import type {
  AdminEpisodeListRow,
  AdminEventRow,
  AdminFeedConfigUpsertRequest,
  AdminFeedListRow,
  AdminSubscriptionFeedRow,
  AdminSubscriptionOpmlRow,
  AdminSyncRunRow,
  DownloaderDefaults,
  EpisodeAdminRow,
  EpisodeStatus,
  EpisodeStatusRow,
  EpisodeUpsertRequest,
  FeedMetadataUpsertRequest,
  FeedStatusRow,
  FeedTomlRow,
  MaxSequenceRow,
  PublicEpisodeRow,
  PublicFeedRow,
  PublicOpmlFeedRow,
  TombstoneChangeRow,
} from "./db";
import type { Env } from "./env";
import {
  deleteMediaObject,
  mediaObjectExists,
  verifyRestorableMediaObject,
} from "./media";
import {
  assertPreviousChangesSQL,
  episodeStatusUpdateBindings,
  episodeStatusUpdateSQL,
  episodeTransition,
  eventInsertSQL,
  feedConfigInsertSQL,
  feedConfigUpdateSQL,
  feedDeleteCandidateCountSQL,
  feedDeleteEpisodeUpdateSQL,
  feedDeleteTombstoneInsertSQL,
  feedDeleteUpdateSQL,
  feedFilterBindings,
  feedFiltersUpsertSQL,
  feedMetadataUpsertSQL,
  oldEventsDeleteSQL,
  oldSyncRunsDeleteSQL,
  purgeCandidatesSQL,
  purgeEpisodeUpdateSQL,
  purgeTombstoneInsertSQL,
  retentionCandidatesSQL,
  retentionEpisodeUpdateSQL,
  retentionGraceDays,
  retentionTombstoneInsertSQL,
  syncRunUpsertSQL,
} from "./sql";
import { sha256Hex } from "./tokens";
import { compileFeedsToml } from "./toml";
import {
  absolutePublicURL,
  adminListLimit,
  adminListOffset,
  badRequest,
  methodNotAllowed,
  nonEmptyString,
  parseAdminEpisodeStatus,
  parseAdminFeedConfigUpsert,
  parseAdminFeedDelete,
  parseAdminFeedStatus,
  parseEpisodeStatusParam,
  parseEpisodeUpsert,
  parseEventBatch,
  parseFeedMetadataUpsert,
  parseIntegerParam,
  pathToken,
  readBoundedJson,
  text,
  tombstoneLimit,
} from "./validators";
import { InvalidMediaBaseURLError, InvalidR2KeyError, renderOpml, renderRss, validateR2Key } from "./xml";

const defaultYoutubeDefaults: DownloaderDefaults = {
	socket_timeout: 12,
	retries: 1,
	fragment_retries: 1,
};
const retentionBatchLimit = 50;
const purgeBatchLimit = 50;
const publicFeedTokenAttempts = 5;

interface PurgeCandidateRow {
  feed_id: string;
  local_episode_id: string;
  r2_key: string | null;
}

interface RetentionCandidateRow {
  feed_id: string;
  local_episode_id: string;
  status: "visible" | "hidden";
}

export interface MaintenanceResult {
  old_events_deleted: number;
  old_sync_runs_deleted: number;
  retention_candidates: number;
  episodes_expired: number;
  retention_errors: number;
  purge_candidates: number;
  episodes_purged: number;
  purge_errors: number;
}

interface ExistingAdminFeedRow {
  feed_id: string;
  provider: AdminFeedConfigUpsertRequest["provider"];
  feed_token_hash: string;
  public_path: string | null;
  deleted_at: string | null;
}

interface FeedDeleteRow {
  feed_id: string;
  deleted_at: string | null;
}

interface FeedDeleteCandidateCountRow {
  candidate_count: number;
}

interface FeedDeletionStateRow {
  deleted_at: string | null;
}


async function dashboardAuthResponse(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!(await isAuthorizedAdminRequest(request, env))) return text("forbidden", 403);

  if (url.searchParams.has("token")) {
    const clean = new URL(url);
    clean.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: {
        "location": `${clean.pathname}${clean.search}${clean.hash}`,
        "cache-control": "no-store",
      },
    });
  }

  return null;
}


function jsonBoolean(value: number): boolean {
  return value === 1;
}

function dbBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function optionalDBBoolean(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function newPublicFeedPath(): string {
  return `/f/${crypto.randomUUID()}.xml`;
}

function tokenFromPublicFeedPath(publicPath: string): string {
  return publicPath.slice("/f/".length, -".xml".length);
}

async function feedTokenHashFromPublicPath(publicPath: string): Promise<string> {
  return sha256Hex(tokenFromPublicFeedPath(publicPath));
}

function feedConfigResponse(request: Request, feed: AdminFeedConfigUpsertRequest, publicPath: string | null) {
  return {
    feed_id: feed.feed_id,
    provider: feed.provider,
    url: feed.url,
    title_override: feed.title_override,
    description_override: feed.description_override,
    enabled: feed.enabled,
    include_in_opml: feed.include_in_opml,
    private_feed: feed.private_feed,
    update_period: feed.update_period,
    page_size: feed.page_size,
    keep_last: feed.keep_last,
    cookie_profile: feed.cookie_profile,
    bilibili: feed.bilibili,
    filters: feed.filters,
    public_feed_url: absolutePublicURL(request, publicPath, "/f/"),
  };
}


function uniqueConstraintMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message;
}

function isPublicFeedTokenConstraintError(error: unknown): boolean {
  const message = uniqueConstraintMessage(error);
  return message.includes("collision") || message.includes("feeds.feed_token_hash") || message.includes("feeds.public_path");
}

function isFeedIDConstraintError(error: unknown): boolean {
  return uniqueConstraintMessage(error).includes("feeds.feed_id");
}

function isFeedDeleteAssertionError(error: unknown): boolean {
  const message = uniqueConstraintMessage(error);
  return message.includes("not null") && message.includes("tombstone_changes");
}


type TombstonedEpisodeStatus = "hidden" | "delete_pending" | "purged";

function tombstoneActionForStatus(status: TombstonedEpisodeStatus): "hide" | "delete" | "purge" {
  switch (status) {
    case "hidden":
      return "hide";
    case "delete_pending":
      return "delete";
    case "purged":
      return "purge";
  }
}

function isTombstonedEpisodeStatus(status: EpisodeStatus): status is TombstonedEpisodeStatus {
  return status === "hidden" || status === "delete_pending" || status === "purged";
}

async function handleNasConfig(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }

  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.enabled,
            f.include_in_opml, f.private_feed, f.update_period, f.page_size, f.keep_last,
            f.cookie_profile, f.bilibili_include_upower_exclusive, f.feed_token_hash,
            ff.title, ff.not_title, ff.description, ff.not_description,
            ff.min_duration, ff.max_duration, ff.min_age, ff.max_age
       FROM feeds f
       LEFT JOIN feed_filters ff ON ff.feed_id = f.feed_id
      WHERE f.enabled = 1
        AND f.deleted_at IS NULL
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

async function handleNasMediaOriginCheck(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }
  if (!env.MEDIA_ORIGIN_BASE_URL) {
    return text("media origin unavailable", 503);
  }

  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object") return badRequest("invalid media origin check body");
  const key = (body as Record<string, unknown>).r2_key;
  if (!nonEmptyString(key)) return badRequest("r2_key is required");
  try {
    validateR2Key(key);
  } catch {
    return badRequest("r2_key is invalid");
  }

  try {
    if (!(await mediaObjectExists(env, key))) return text("not found", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = /^media origin HEAD returned ([0-9]{3})$/.exec(message)?.[1];
    return text(status ? `media origin check failed: upstream status ${status}` : "media origin check failed: upstream request failed", 502);
  }
  return new Response(null, { status: 204 });
}

async function handleAdminFeeds(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override,
            f.enabled, f.include_in_opml, f.private_feed, f.update_period,
            f.page_size, f.keep_last, f.cookie_profile, f.bilibili_include_upower_exclusive,
            f.public_path,
            m.title AS metadata_title, m.description AS metadata_description,
            m.image_url AS metadata_image_url,
            m.last_source_update_at AS metadata_last_source_update_at, m.reported_at AS metadata_reported_at,
            ep.latest_episode_published_at, COALESCE(ep.episode_count, 0) AS episode_count,
            ff.title, ff.not_title, ff.description, ff.not_description,
            ff.min_duration, ff.max_duration, ff.min_age, ff.max_age
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
       LEFT JOIN feed_filters ff ON ff.feed_id = f.feed_id
       LEFT JOIN (
            SELECT feed_id,
                   MAX(strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(datetime(published_at), datetime(updated_at)))) AS latest_episode_published_at,
                   COUNT(*) AS episode_count
              FROM episodes
             WHERE status != 'purged'
             GROUP BY feed_id
       ) ep ON ep.feed_id = f.feed_id
      WHERE f.deleted_at IS NULL
      ORDER BY f.feed_id ASC`,
  ).all<AdminFeedListRow>();

  return Response.json({
    feeds: results.map((feed) => ({
      feed_id: feed.feed_id,
      provider: feed.provider,
      url: feed.url,
      title_override: feed.title_override,
      description_override: feed.description_override,
      title: feed.metadata_title ?? feed.title_override ?? feed.feed_id,
      description: feed.metadata_description ?? feed.description_override ?? null,
      image_url: feed.metadata_image_url,
      last_source_update_at: feed.metadata_last_source_update_at,
      metadata_reported_at: feed.metadata_reported_at,
      latest_episode_published_at: feed.latest_episode_published_at,
      episode_count: feed.episode_count,
      enabled: jsonBoolean(feed.enabled),
      include_in_opml: jsonBoolean(feed.include_in_opml),
      private_feed: jsonBoolean(feed.private_feed),
      update_period: feed.update_period,
      page_size: feed.page_size,
      keep_last: feed.keep_last,
      cookie_profile: feed.cookie_profile,
      bilibili: {
        include_upower_exclusive: feed.provider === "bilibili" && jsonBoolean(feed.bilibili_include_upower_exclusive ?? 0),
      },
      filters: {
        title: feed.title,
        not_title: feed.not_title,
        description: feed.description,
        not_description: feed.not_description,
        min_duration: feed.min_duration,
        max_duration: feed.max_duration,
        min_age: feed.min_age,
        max_age: feed.max_age,
      },
      public_feed_url: absolutePublicURL(request, feed.public_path, "/f/"),
    })),
  });
}

async function handleAdminFeedUpsert(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const parsed = parseAdminFeedConfigUpsert(body);
  if (parsed instanceof Response) return parsed;

  const existing = await env.DB.prepare(
    `SELECT feed_id, provider, feed_token_hash, public_path, deleted_at
       FROM feeds
      WHERE feed_id = ?`,
  ).bind(parsed.feed_id).first<ExistingAdminFeedRow>();
  if (existing?.deleted_at) return text("feed is deleted", 409);
  if (existing && existing.provider !== parsed.provider) {
    return badRequest("provider cannot be changed");
  }

  if (!existing) {
    return createAdminFeed(request, env, parsed);
  }

  const update = env.DB.prepare(feedConfigUpdateSQL()).bind(
    parsed.url,
    parsed.title_override,
    parsed.description_override,
    dbBoolean(parsed.enabled),
    dbBoolean(parsed.include_in_opml),
    dbBoolean(parsed.private_feed),
    parsed.update_period,
    parsed.page_size,
    parsed.keep_last,
    parsed.cookie_profile,
    dbBoolean(parsed.bilibili.include_upower_exclusive),
    parsed.feed_id,
  );
  const filters = env.DB.prepare(feedFiltersUpsertSQL()).bind(...feedFilterBindings(parsed));
  try {
    const [feedResult] = await env.DB.batch([update, env.DB.prepare(assertPreviousChangesSQL()).bind(1), filters]);
    if (feedResult?.meta.changes !== 1) return text("feed update failed", 500);
  } catch (error) {
    if (isFeedDeleteAssertionError(error)) return text("feed changed concurrently", 409);
    return text("feed config upsert failed", 500);
  }

  return Response.json({
    ok: true,
    created: false,
    feed: feedConfigResponse(request, parsed, existing.public_path),
  });
}

async function createAdminFeed(request: Request, env: Env, parsed: AdminFeedConfigUpsertRequest): Promise<Response> {
  for (let attempt = 0; attempt < publicFeedTokenAttempts; attempt++) {
    const publicPath = newPublicFeedPath();
    const feedTokenHash = await feedTokenHashFromPublicPath(publicPath);
    const insert = env.DB.prepare(feedConfigInsertSQL()).bind(
      parsed.feed_id,
      parsed.provider,
      parsed.url,
      parsed.title_override,
      parsed.description_override,
      dbBoolean(parsed.enabled),
      dbBoolean(parsed.include_in_opml),
      dbBoolean(parsed.private_feed),
      parsed.update_period,
      parsed.page_size,
      parsed.keep_last,
      parsed.cookie_profile,
      dbBoolean(parsed.bilibili.include_upower_exclusive),
      feedTokenHash,
      publicPath,
    );
    const filters = env.DB.prepare(feedFiltersUpsertSQL()).bind(...feedFilterBindings(parsed));
    try {
      await env.DB.batch([insert, filters]);
      return Response.json({
        ok: true,
        created: true,
        feed: feedConfigResponse(request, parsed, publicPath),
      });
    } catch (error) {
      if (isPublicFeedTokenConstraintError(error)) continue;
      if (isFeedIDConstraintError(error)) return text("feed already exists", 409);
      return text("feed config upsert failed", 500);
    }
  }
  return text("failed to generate public feed token", 500);
}

async function handleAdminFeedStatus(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const parsed = parseAdminFeedStatus(body);
  if (parsed instanceof Response) return parsed;

  const feed = await env.DB.prepare(
    `SELECT feed_id, enabled, include_in_opml, deleted_at
       FROM feeds
      WHERE feed_id = ? AND deleted_at IS NULL`,
  ).bind(parsed.feed_id).first<FeedStatusRow>();
  if (!feed) return text("feed not found", 404);

  const enabled = parsed.enabled === undefined ? feed.enabled : parsed.enabled ? 1 : 0;
  const includeInOpml = parsed.include_in_opml === undefined ? feed.include_in_opml : parsed.include_in_opml ? 1 : 0;

  const result = await env.DB.prepare(
    `UPDATE feeds
        SET enabled = ?, include_in_opml = ?
      WHERE feed_id = ? AND deleted_at IS NULL`,
  ).bind(enabled, includeInOpml, parsed.feed_id).run();
  if (result.meta.changes !== 1) return text("feed changed concurrently", 409);

  return Response.json({
    ok: true,
    feed_id: parsed.feed_id,
    enabled: enabled === 1,
    include_in_opml: includeInOpml === 1,
  });
}

async function handleAdminFeedDelete(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const parsed = parseAdminFeedDelete(body);
  if (parsed instanceof Response) return parsed;

  const feed = await env.DB.prepare(
    `SELECT feed_id, deleted_at
       FROM feeds
      WHERE feed_id = ?`,
  ).bind(parsed.feed_id).first<FeedDeleteRow>();
  if (!feed) return text("feed not found", 404);
  if (feed.deleted_at) {
    return Response.json({
      ok: true,
      feed_id: parsed.feed_id,
      deleted: false,
      episodes_marked: 0,
    });
  }

  const count = await env.DB.prepare(feedDeleteCandidateCountSQL()).bind(parsed.feed_id).first<FeedDeleteCandidateCountRow>();
  const candidateCount = count?.candidate_count ?? 0;
  const statements = [
    env.DB.prepare(feedDeleteTombstoneInsertSQL()).bind(parsed.feed_id),
    env.DB.prepare(assertPreviousChangesSQL()).bind(candidateCount),
    env.DB.prepare(feedDeleteEpisodeUpdateSQL()).bind(parsed.feed_id),
    env.DB.prepare(assertPreviousChangesSQL()).bind(candidateCount),
    env.DB.prepare(feedDeleteUpdateSQL()).bind(parsed.feed_id),
    env.DB.prepare(assertPreviousChangesSQL()).bind(1),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isFeedDeleteAssertionError(error)) return text("feed delete changed concurrently", 409);
    return text("feed delete failed", 500);
  }

  return Response.json({
    ok: true,
    feed_id: parsed.feed_id,
    deleted: true,
    episodes_marked: candidateCount,
  });
}

async function selectEpisodeAdminRow(env: Env, feedID: string, localEpisodeID: string): Promise<EpisodeAdminRow | null> {
  return env.DB.prepare(
    `SELECT feed_id, local_episode_id, status, r2_key
       FROM episodes
      WHERE feed_id = ? AND local_episode_id = ?`,
  ).bind(feedID, localEpisodeID).first<EpisodeAdminRow>();
}

async function deletedFeedMutationGuard(env: Env, feedID: string): Promise<Response | null> {
  const feed = await env.DB.prepare(
    `SELECT deleted_at
       FROM feeds
      WHERE feed_id = ?`,
  ).bind(feedID).first<FeedDeletionStateRow>();
  if (feed?.deleted_at) return text("feed not found", 404);
  return null;
}

async function handleAdminEpisodeStatus(request: Request, env: Env): Promise<Response> {
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const parsed = parseAdminEpisodeStatus(body);
  if (parsed instanceof Response) return parsed;

  const deletedFeed = await deletedFeedMutationGuard(env, parsed.feed_id);
  if (deletedFeed) return deletedFeed;

  const episode = await selectEpisodeAdminRow(env, parsed.feed_id, parsed.local_episode_id);
  if (!episode) return text("episode not found", 404);

  const transition = episodeTransition(episode.status, parsed.action);
  if (transition.conflict) return text(transition.conflict, 409);
  if (!transition.changed) {
    return Response.json({
      ok: true,
      feed_id: parsed.feed_id,
      local_episode_id: parsed.local_episode_id,
      action: parsed.action,
      status: transition.status,
      changed: false,
    });
  }

  const restoreGuard = await verifyRestorableMediaObject(env, parsed.action, episode);
  if (restoreGuard) return restoreGuard;

  const updateStatement = env.DB.prepare(episodeStatusUpdateSQL(parsed.action, episode)).bind(
    ...episodeStatusUpdateBindings(parsed.action, episode, parsed.feed_id, parsed.local_episode_id),
  );
  const tombstoneStatement = env.DB.prepare(
    `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
     SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP
      WHERE changes() = 1`,
  ).bind(parsed.feed_id, parsed.local_episode_id, transition.status, transition.action);

  let results: D1Result[];
  try {
    results = await env.DB.batch([updateStatement, tombstoneStatement]);
  } catch {
    const current = await selectEpisodeAdminRow(env, parsed.feed_id, parsed.local_episode_id);
    const currentTransition = current ? episodeTransition(current.status, parsed.action) : null;
    if (!current || currentTransition?.conflict) {
      return text(`episode status changed concurrently: ${current?.status ?? "missing"}`, 409);
    }
    return text("episode status update failed", 500);
  }

  const [updateResult, tombstoneResult] = results;
  if (updateResult?.meta.changes !== 1 || tombstoneResult?.meta.changes !== 1) {
    const current = await selectEpisodeAdminRow(env, parsed.feed_id, parsed.local_episode_id);
    return text(`episode status changed concurrently: ${current?.status ?? "missing"}`, 409);
  }

  return Response.json({
    ok: true,
    feed_id: parsed.feed_id,
    local_episode_id: parsed.local_episode_id,
    action: parsed.action,
    status: transition.status,
    changed: true,
  });
}

async function handleAdminEpisodes(url: URL, env: Env): Promise<Response> {
  const feedID = url.searchParams.get("feed_id");
  if (!feedID || feedID.trim() === "") return badRequest("feed_id is required");
  const status = parseEpisodeStatusParam(url.searchParams.get("status"));
  if (status instanceof Response) return status;
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const exists = await env.DB.prepare(
    `SELECT feed_id
       FROM feeds
      WHERE feed_id = ? AND deleted_at IS NULL`,
  ).bind(feedID).first<{ feed_id: string }>();
  if (!exists) return text("feed not found", 404);

  const whereStatus = status ? " AND status = ?" : "";
  const bindings: unknown[] = status ? [feedID, status, limit, offset] : [feedID, limit, offset];
  const { results } = await env.DB.prepare(
    `SELECT local_episode_id, source_episode_id, source_url, title, published_at,
            duration, status, r2_key, size, mime_type, updated_at
       FROM episodes
      WHERE feed_id = ?${whereStatus}
      ORDER BY COALESCE(datetime(published_at), datetime(updated_at)) DESC, local_episode_id ASC
      LIMIT ? OFFSET ?`,
  ).bind(...bindings).all<AdminEpisodeListRow>();

  return Response.json({
    feed_id: feedID,
    limit,
    offset,
    episodes: results.map((episode) => ({
      local_episode_id: episode.local_episode_id,
      source_episode_id: episode.source_episode_id,
      source_url: episode.source_url,
      title: episode.title,
      published_at: episode.published_at,
      duration: episode.duration,
      status: episode.status,
      has_media: episode.r2_key !== null && episode.r2_key !== "",
      size: episode.size,
      mime_type: episode.mime_type,
      updated_at: episode.updated_at,
    })),
  });
}

async function handleAdminSubscriptions(request: Request, env: Env): Promise<Response> {
  const { results: feeds } = await env.DB.prepare(
    `SELECT f.feed_id, f.title_override, f.public_path, m.title
      FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.public_path IS NOT NULL
        AND f.deleted_at IS NULL
      ORDER BY f.feed_id ASC`,
  ).all<AdminSubscriptionFeedRow>();

  const { results: opml } = await env.DB.prepare(
    `SELECT label, public_path
       FROM opml_tokens
      WHERE enabled = 1 AND public_path IS NOT NULL
      ORDER BY label ASC`,
  ).all<AdminSubscriptionOpmlRow>();

  return Response.json({
    feeds: feeds.flatMap((feed) => {
      const xmlURL = absolutePublicURL(request, feed.public_path, "/f/");
      if (!xmlURL) return [];
      return [{ feed_id: feed.feed_id, title: feed.title ?? feed.title_override ?? feed.feed_id, xml_url: xmlURL }];
    }),
    opml: opml.flatMap((token) => {
      const xmlURL = absolutePublicURL(request, token.public_path, "/opml/");
      if (!xmlURL) return [];
      return [{ label: token.label, xml_url: xmlURL }];
    }),
  });
}

async function handleAdminSyncRuns(url: URL, env: Env): Promise<Response> {
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const { results } = await env.DB.prepare(
    `SELECT id, started_at, finished_at, status, feeds_updated,
            episodes_downloaded, episodes_uploaded, errors_count
       FROM sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<AdminSyncRunRow>();

  return Response.json({ limit, offset, sync_runs: results });
}

async function handleAdminEvents(url: URL, env: Env): Promise<Response> {
  const limit = adminListLimit(url, 50, 200);
  if (limit instanceof Response) return limit;
  const offset = adminListOffset(url);
  if (offset instanceof Response) return offset;

  const { results } = await env.DB.prepare(
    `SELECT run_id, sequence, event_time, level, type, feed_id,
            local_episode_id, message, error_code, error_detail
       FROM events
      ORDER BY event_time DESC, run_id DESC, sequence DESC
      LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<AdminEventRow>();

  return Response.json({ limit, offset, events: results });
}

async function handleNasEventsBatch(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }
  const rawBody = await readBoundedJson(request);
  if (rawBody instanceof Response) return rawBody;

  const parsed = parseEventBatch(rawBody);
  if (parsed instanceof Response) return parsed;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(syncRunUpsertSQL()).bind(
      parsed.run.id,
      parsed.run.started_at,
      parsed.run.finished_at ?? null,
      parsed.run.status,
      parsed.run.feeds_updated,
      parsed.run.episodes_downloaded,
      parsed.run.episodes_uploaded,
      parsed.run.errors_count,
    ),
  ];

  for (const event of parsed.events) {
    statements.push(env.DB.prepare(eventInsertSQL()).bind(
      parsed.run.id,
      event.sequence,
      event.event_time,
      event.level,
      event.type,
      event.feed_id ?? null,
      event.local_episode_id ?? null,
      event.message ?? null,
      event.error_code ?? null,
      event.error_detail ?? null,
    ));
  }

  const results = await env.DB.batch(statements);
  const insertedEvents = results.slice(1).reduce((count, result) => count + (result.meta.changes ?? 0), 0);

  return Response.json({
    ok: true,
    run_id: parsed.run.id,
    accepted_events: parsed.events.length,
    inserted_events: insertedEvents,
    duplicate_events: parsed.events.length - insertedEvents,
  });
}

async function handleFeedMetadataUpsert(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }
  const rawBody = await readBoundedJson(request);
  if (rawBody instanceof Response) return rawBody;

  const parsed = parseFeedMetadataUpsert(rawBody);
  if (parsed instanceof Response) return parsed;

  const feed = await env.DB.prepare(
    `SELECT feed_id, provider
       FROM feeds
      WHERE feed_id = ? AND deleted_at IS NULL`,
  ).bind(parsed.feed_id).first<{ feed_id: string; provider: FeedMetadataUpsertRequest["provider"] }>();
  if (!feed) return text("feed not found", 404);
  if (feed.provider !== parsed.provider) return badRequest("provider mismatch");

  const upsertResult = await env.DB.prepare(feedMetadataUpsertSQL()).bind(
    parsed.feed_id,
    parsed.provider,
    parsed.source_url,
    parsed.title ?? null,
    parsed.description ?? null,
    parsed.image_url ?? null,
    parsed.link ?? null,
    parsed.author ?? null,
    parsed.category ?? null,
    parsed.language ?? null,
    optionalDBBoolean(parsed.explicit),
    parsed.last_source_update_at ?? null,
    parsed.reported_at,
    parsed.feed_id,
  ).run();
  if (upsertResult.meta.changes !== 1) return text("feed not found", 404);

  return Response.json({ ok: true, feed_id: parsed.feed_id });
}

export async function runScheduledMaintenance(env: Env, now = new Date()): Promise<MaintenanceResult> {
  const nowISO = now.toISOString();
  const purgeAfterISO = new Date(now.getTime() + retentionGraceDays * 24 * 60 * 60 * 1000).toISOString();
  const oldEvents = await env.DB.prepare(oldEventsDeleteSQL()).bind(nowISO).run();
  const oldSyncRuns = await env.DB.prepare(oldSyncRunsDeleteSQL()).bind(nowISO).run();
  const { results: retentionCandidates } = await env.DB.prepare(retentionCandidatesSQL()).bind(retentionBatchLimit).all<RetentionCandidateRow>();

  const result: MaintenanceResult = {
    old_events_deleted: oldEvents.meta.changes ?? 0,
    old_sync_runs_deleted: oldSyncRuns.meta.changes ?? 0,
    retention_candidates: retentionCandidates.length,
    episodes_expired: 0,
    retention_errors: 0,
    purge_candidates: 0,
    episodes_purged: 0,
    purge_errors: 0,
  };

  for (const candidate of retentionCandidates) {
    try {
      if (await expireRetentionCandidate(env, candidate, nowISO, purgeAfterISO)) {
        result.episodes_expired++;
      } else {
        result.retention_errors++;
      }
    } catch (error) {
      result.retention_errors++;
      console.warn(JSON.stringify({
        message: "scheduled retention candidate failed",
        feed_id: candidate.feed_id,
        local_episode_id: candidate.local_episode_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const { results: candidates } = await env.DB.prepare(purgeCandidatesSQL()).bind(nowISO, purgeBatchLimit).all<PurgeCandidateRow>();
  result.purge_candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      if (await purgeEpisodeCandidate(env, candidate, nowISO)) {
        result.episodes_purged++;
      } else {
        result.purge_errors++;
      }
    } catch (error) {
      result.purge_errors++;
      console.warn("scheduled purge candidate failed", {
        feed_id: candidate.feed_id,
        local_episode_id: candidate.local_episode_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function expireRetentionCandidate(
  env: Env,
  candidate: RetentionCandidateRow,
  nowISO: string,
  purgeAfterISO: string,
): Promise<boolean> {
  const update = env.DB.prepare(retentionEpisodeUpdateSQL()).bind(
    nowISO,
    purgeAfterISO,
    nowISO,
    candidate.feed_id,
    candidate.local_episode_id,
    candidate.status,
  );
  const tombstone = env.DB.prepare(retentionTombstoneInsertSQL()).bind(
    candidate.feed_id,
    candidate.local_episode_id,
    nowISO,
  );
  const [updateResult, tombstoneResult] = await env.DB.batch([update, tombstone]);
  return updateResult?.meta.changes === 1 && tombstoneResult?.meta.changes === 1;
}

async function purgeEpisodeCandidate(env: Env, candidate: PurgeCandidateRow, nowISO: string): Promise<boolean> {
  if (candidate.r2_key) {
    await deleteMediaObject(env, candidate.r2_key);
  }

  const update = env.DB.prepare(purgeEpisodeUpdateSQL()).bind(
    nowISO,
    candidate.feed_id,
    candidate.local_episode_id,
    candidate.r2_key,
    candidate.r2_key,
    nowISO,
  );
  const tombstone = env.DB.prepare(purgeTombstoneInsertSQL()).bind(
    candidate.feed_id,
    candidate.local_episode_id,
    nowISO,
  );
  const [updateResult, tombstoneResult] = await env.DB.batch([update, tombstone]);
  return updateResult?.meta.changes === 1 && tombstoneResult?.meta.changes === 1;
}

async function handleEpisodeUpsert(request: Request, env: Env): Promise<Response> {
	if (!(await isAuthorizedNasRequest(request, env))) {
		return text("unauthorized", 401);
	}
	const rawBody = await readBoundedJson(request);
	if (rawBody instanceof Response) return rawBody;

	const parsed = parseEpisodeUpsert(rawBody);
	if (parsed instanceof Response) return parsed;

	const feed = await env.DB.prepare(
		`SELECT feed_id, provider
		   FROM feeds
		  WHERE feed_id = ? AND deleted_at IS NULL`,
	).bind(parsed.feed_id).first<{ feed_id: string; provider: EpisodeUpsertRequest["provider"] }>();

	if (!feed) return text("feed not found", 404);
	if (feed.provider !== parsed.provider) return badRequest("provider mismatch");

	const upsertResult = await env.DB.prepare(
		`INSERT INTO episodes (
		    feed_id, provider, source_episode_id, local_episode_id, source_url, thumbnail,
		    title, description, published_at, duration, status, r2_key, size, mime_type,
		    asset_token, created_at, updated_at
		  )
		  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		   WHERE EXISTS (
		     SELECT 1 FROM feeds
		      WHERE feed_id = ?
		        AND deleted_at IS NULL
		   )
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
		    updated_at = CURRENT_TIMESTAMP
		   WHERE EXISTS (
		     SELECT 1 FROM feeds
		      WHERE feeds.feed_id = episodes.feed_id
		        AND feeds.deleted_at IS NULL
		   )`,
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
		parsed.feed_id,
	).run();
	if (upsertResult.meta.changes !== 1) return text("feed not found", 404);

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

async function maxTombstoneSequence(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MAX(sequence) AS max_sequence FROM tombstone_changes`,
  ).first<MaxSequenceRow>();
  return row?.max_sequence ?? 0;
}

async function handleNasTombstones(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await isAuthorizedNasRequest(request, env))) {
    return text("unauthorized", 401);
  }

  const cursor = parseIntegerParam(url.searchParams.get("cursor"), 0, "cursor");
  if (cursor instanceof Response) return cursor;
  const limit = tombstoneLimit(url);
  if (limit instanceof Response) return limit;

  if (cursor === 0) {
    const highWatermark = await maxTombstoneSequence(env);
    const { results } = await env.DB.prepare(
      `SELECT 0 AS sequence, feed_id, local_episode_id, status,
              updated_at AS created_at
         FROM episodes
        WHERE status IN ('hidden', 'delete_pending', 'purged')
        ORDER BY feed_id ASC, local_episode_id ASC`,
    ).all<Omit<TombstoneChangeRow, "action">>();
    const changes = results.flatMap((row) => {
      if (!isTombstonedEpisodeStatus(row.status)) return [];
      return [{
        ...row,
        status: row.status,
        action: tombstoneActionForStatus(row.status),
      }];
    });
    return Response.json({
      cursor,
      next_cursor: highWatermark,
      has_more: false,
      changes,
    });
  }

  const { results } = await env.DB.prepare(
    `SELECT sequence, feed_id, local_episode_id, status, action, created_at
       FROM tombstone_changes
      WHERE sequence > ?
      ORDER BY sequence ASC
      LIMIT ?`,
  ).bind(cursor, limit + 1).all<TombstoneChangeRow>();
  const changes = results.slice(0, limit);
  const nextCursor = changes.reduce((max, row) => Math.max(max, row.sequence), cursor);
  return Response.json({
    cursor,
    next_cursor: nextCursor,
    has_more: results.length > limit,
    changes,
  });
}

async function handleFeedXml(pathname: string, request: Request, env: Env): Promise<Response> {
  const token = pathToken(pathname, "/f/");
  if (!token) return text("not found", 404);

  const tokenHash = await sha256Hex(token);
  const feed = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.private_feed, f.page_size,
            f.deleted_at, m.title, m.description, m.image_url, m.link,
            m.author, m.category, m.language, m.explicit
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.feed_token_hash = ?`,
  ).bind(tokenHash).first<PublicFeedRow>();

  if (!feed) return text("not found", 404);
  if (feed.deleted_at) return text("feed deleted", 410);

  const limit = feed.page_size > 0 ? feed.page_size : 25;
  const { results: episodes } = await env.DB.prepare(
    `SELECT local_episode_id, source_url, thumbnail, title, description, published_at, duration,
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
        imageURL: feed.image_url,
        author: feed.author,
        category: feed.category,
        language: feed.language,
        explicit: feed.explicit === 1,
        privateFeed: feed.private_feed === 1,
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

async function handleOpml(pathname: string, request: Request, env: Env): Promise<Response> {
  const token = pathToken(pathname, "/opml/");
  if (!token) return text("not found", 404);

  const tokenHash = await sha256Hex(token);
  const opmlToken = await env.DB.prepare(
    `SELECT id
       FROM opml_tokens
      WHERE enabled = 1 AND token_hash = ?`,
  ).bind(tokenHash).first<{ id: number }>();

  if (!opmlToken) return text("not found", 404);

  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.title_override, f.public_path, m.title
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.enabled = 1
        AND f.deleted_at IS NULL
        AND f.include_in_opml = 1
        AND f.public_path IS NOT NULL
      ORDER BY f.feed_id ASC`,
  ).all<PublicOpmlFeedRow>();

  const feeds = results.flatMap((feed) => {
    const xmlUrl = absolutePublicURL(request, feed.public_path, "/f/");
    if (!xmlUrl) return [];
    return [{
      title: feed.title ?? feed.title_override ?? feed.feed_id,
      xmlUrl,
    }];
  });

  return text(renderOpml(feeds), 200, "text/x-opml; charset=utf-8");
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

    if (url.pathname === "/api/nas/media-origin/check") {
      if (request.method !== "POST") return methodNotAllowed();
      return handleNasMediaOriginCheck(request, env);
    }

    if (url.pathname === "/api/nas/episodes/upsert") {
      if (request.method !== "POST") return methodNotAllowed();
      return handleEpisodeUpsert(request, env);
    }

    if (url.pathname === "/api/nas/feed-metadata/upsert") {
      if (request.method !== "POST") return methodNotAllowed();
      return handleFeedMetadataUpsert(request, env);
    }

    if (url.pathname === "/api/nas/tombstones") {
      if (request.method !== "GET") return methodNotAllowed();
      return handleNasTombstones(request, env, url);
    }

    if (url.pathname === "/api/nas/events/batch") {
      if (request.method !== "POST") return methodNotAllowed();
      return handleNasEventsBatch(request, env);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!(await isAuthorizedAdminRequest(request, env))) return text("forbidden", 403);
      if (url.pathname === "/api/admin/feeds") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleAdminFeeds(request, env);
      }
      if (url.pathname === "/api/admin/feeds/upsert") {
        if (request.method !== "POST") return methodNotAllowed();
        return handleAdminFeedUpsert(request, env);
      }
      if (url.pathname === "/api/admin/episodes") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleAdminEpisodes(url, env);
      }
      if (url.pathname === "/api/admin/subscriptions") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleAdminSubscriptions(request, env);
      }
      if (url.pathname === "/api/admin/sync-runs") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleAdminSyncRuns(url, env);
      }
      if (url.pathname === "/api/admin/events") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleAdminEvents(url, env);
      }
      if (url.pathname === "/api/admin/feeds/status") {
        if (request.method !== "POST") return methodNotAllowed();
        return handleAdminFeedStatus(request, env);
      }
      if (url.pathname === "/api/admin/feeds/delete") {
        if (request.method !== "POST") return methodNotAllowed();
        return handleAdminFeedDelete(request, env);
      }
      if (url.pathname === "/api/admin/episodes/status") {
        if (request.method !== "POST") return methodNotAllowed();
        return handleAdminEpisodeStatus(request, env);
      }
      return text("not found", 404);
    }

    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      if (request.method !== "GET") return methodNotAllowed();
      const authResponse = await dashboardAuthResponse(request, env, url);
      if (authResponse) return authResponse;
      return dashboardResponse();
    }

    if (url.pathname.startsWith("/f/")) {
      if (request.method !== "GET") return methodNotAllowed();
      return handleFeedXml(url.pathname, request, env);
    }

    if (url.pathname.startsWith("/opml/")) {
      if (request.method !== "GET") return methodNotAllowed();
      return handleOpml(url.pathname, request, env);
    }

    return text("not found", 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(env).then(
      (result) => console.log("scheduled maintenance completed", result),
      (error) => console.error("scheduled maintenance failed", error),
    ));
  },
} satisfies ExportedHandler<Env>;
