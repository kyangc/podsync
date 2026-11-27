import type {
  AdminEpisodeAction,
  AdminEpisodeStatusRequest,
  AdminFeedConfigUpsertRequest,
  AdminFeedDeleteRequest,
  AdminFeedFilters,
  AdminFeedStatusRequest,
  EpisodeStatus,
  EpisodeUpsertRequest,
  EventBatchRequest,
  EventLevel,
  FeedMetadataUpsertRequest,
  RemoteEventInput,
  RemoteEventType,
  SyncRunStatus,
  SyncRunUpsertRequest,
} from "./db";
import { InvalidR2KeyError, validateR2Key } from "./xml";

const maxJsonBodyBytes = 64 * 1024;
const publicPathTokenPattern = /^[A-Za-z0-9_-]+$/;
const maxEventBatchEvents = 100;
const maxRunIDLength = 128;
const maxEventTypeLength = 64;
const maxEventMessageLength = 512;
const maxEventCodeLength = 128;
const maxEventDetailLength = 2048;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const maxFeedIDLength = 128;
const maxFeedStringLength = 512;
const maxFeedURLLength = 2048;
const maxUpdatePeriodLength = 64;
const maxPageSize = 200;
const maxKeepLast = 1000;
const feedIDPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const goDurationPattern = /^(?:[1-9]\d*(?:ns|us|µs|ms|s|m|h))+$/;

const syncRunStatuses = new Set<SyncRunStatus>(["running", "success", "partial", "failed"]);
const eventLevels = new Set<EventLevel>(["debug", "info", "warn", "error"]);
const remoteEventTypes = new Set<RemoteEventType>([
  "sync_run_started",
  "sync_run_finished",
  "remote_config_fetched",
  "remote_config_fallback_used",
  "remote_config_invalid",
  "feed_update_started",
  "feed_update_finished",
  "feed_update_failed",
  "episode_discovered",
  "episode_download_finished",
  "episode_download_failed",
  "episode_upload_finished",
  "episode_upload_failed",
  "episode_report_finished",
  "episode_report_failed",
  "tombstone_fetched",
  "tombstone_applied",
  "tombstone_apply_failed",
  "r2_probe_failed",
  "remote_api_failed",
  "cookie_profile_missing",
  "cookie_profile_invalid",
]);


export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}


export function pathToken(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".xml")) return null;
  const token = pathname.slice(prefix.length, -".xml".length);
  if (token === "") return null;
  try {
    return decodeURIComponent(token);
  } catch {
    return null;
  }
}

export function validPublicXmlPath(path: string | null, prefix: "/f/" | "/opml/"): path is string {
  if (path === null) return false;
  if (!path.startsWith(prefix) || !path.endsWith(".xml")) return false;
  const token = path.slice(prefix.length, -".xml".length);
  return publicPathTokenPattern.test(token);
}

export function absolutePublicURL(request: Request, path: string | null, prefix: "/f/" | "/opml/"): string | null {
  if (!validPublicXmlPath(path, prefix)) return null;
  return new URL(path, new URL(request.url).origin).toString();
}

export function methodNotAllowed(): Response {
	return text("method not allowed", 405);
}

export function badRequest(message: string): Response {
	return text(message, 400);
}

function isJsonContentType(request: Request): boolean {
	const contentType = request.headers.get("content-type") ?? "";
	return contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

export async function readBoundedJson(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request)) {
    return badRequest("content-type must be application/json");
  }
  const bodyText = await readBoundedText(request, maxJsonBodyBytes);
  if (bodyText === null) {
    return badRequest("request body too large");
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return badRequest("invalid json");
  }
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

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isProvider(value: unknown): value is EpisodeUpsertRequest["provider"] {
	return value === "youtube" || value === "bilibili";
}

function validDateString(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const [, year, month, day, hour, minute, second] = match;
  return parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day)
    && parsed.getUTCHours() === Number(hour)
    && parsed.getUTCMinutes() === Number(minute)
    && parsed.getUTCSeconds() === Number(second);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalBoundedString(value: unknown, maxLength: number, name: string): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return badRequest(`${name} must be string`);
  if (value.length > maxLength) return badRequest(`${name} is too long`);
  return value;
}

export function parseEpisodeUpsert(body: unknown): EpisodeUpsertRequest | Response {
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

function parseSyncRunUpsert(value: unknown): SyncRunUpsertRequest | Response {
  if (!value || typeof value !== "object") return badRequest("run is required");
  const run = value as Record<string, unknown>;
  if (!nonEmptyString(run.id) || run.id.length > maxRunIDLength) return badRequest("run.id is invalid");
  if (!nonEmptyString(run.started_at) || !validDateString(run.started_at)) return badRequest("run.started_at is invalid");
  const finishedAt = run.finished_at;
  let finishedAtValue: string | null = null;
  if (finishedAt !== undefined && finishedAt !== null && (!nonEmptyString(finishedAt) || !validDateString(finishedAt))) {
    return badRequest("run.finished_at is invalid");
  }
  if (typeof finishedAt === "string") finishedAtValue = finishedAt;
  if (typeof run.status !== "string" || !syncRunStatuses.has(run.status as SyncRunStatus)) {
    return badRequest("run.status is invalid");
  }
  const status = run.status as SyncRunStatus;
  if (status === "running" && finishedAtValue !== null) {
    return badRequest("run.finished_at must be null while running");
  }
  if (status !== "running" && finishedAtValue === null) {
    return badRequest("run.finished_at is required for final status");
  }
  if (finishedAtValue !== null && finishedAtValue < run.started_at) {
    return badRequest("run.finished_at must be after started_at");
  }
  const feedsUpdated = run.feeds_updated;
  if (!nonNegativeInteger(feedsUpdated)) return badRequest("run.feeds_updated is invalid");
  const episodesDownloaded = run.episodes_downloaded;
  if (!nonNegativeInteger(episodesDownloaded)) return badRequest("run.episodes_downloaded is invalid");
  const episodesUploaded = run.episodes_uploaded;
  if (!nonNegativeInteger(episodesUploaded)) return badRequest("run.episodes_uploaded is invalid");
  const errorsCount = run.errors_count;
  if (!nonNegativeInteger(errorsCount)) return badRequest("run.errors_count is invalid");
  return {
    id: run.id,
    started_at: run.started_at,
    finished_at: finishedAtValue,
    status,
    feeds_updated: feedsUpdated,
    episodes_downloaded: episodesDownloaded,
    episodes_uploaded: episodesUploaded,
    errors_count: errorsCount,
  };
}

function parseRemoteEvent(value: unknown): RemoteEventInput | Response {
  if (!value || typeof value !== "object") return badRequest("event is invalid");
  const event = value as Record<string, unknown>;
  if (!positiveInteger(event.sequence)) return badRequest("event.sequence is invalid");
  if (!nonEmptyString(event.event_time) || !validDateString(event.event_time)) return badRequest("event.event_time is invalid");
  if (typeof event.level !== "string" || !eventLevels.has(event.level as EventLevel)) {
    return badRequest("event.level is invalid");
  }
  if (typeof event.type !== "string" || event.type.length > maxEventTypeLength || !remoteEventTypes.has(event.type as RemoteEventType)) {
    return badRequest("event.type is invalid");
  }

  const feedID = optionalBoundedString(event.feed_id, maxRunIDLength, "event.feed_id");
  if (feedID instanceof Response) return feedID;
  const localEpisodeID = optionalBoundedString(event.local_episode_id, maxRunIDLength, "event.local_episode_id");
  if (localEpisodeID instanceof Response) return localEpisodeID;
  const message = optionalBoundedString(event.message, maxEventMessageLength, "event.message");
  if (message instanceof Response) return message;
  const errorCode = optionalBoundedString(event.error_code, maxEventCodeLength, "event.error_code");
  if (errorCode instanceof Response) return errorCode;
  const errorDetail = optionalBoundedString(event.error_detail, maxEventDetailLength, "event.error_detail");
  if (errorDetail instanceof Response) return errorDetail;

  return {
    sequence: event.sequence,
    event_time: event.event_time,
    level: event.level as EventLevel,
    type: event.type as RemoteEventType,
    feed_id: feedID,
    local_episode_id: localEpisodeID,
    message,
    error_code: errorCode,
    error_detail: errorDetail,
  };
}

export function parseEventBatch(body: unknown): EventBatchRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid event batch body");
  const value = body as Record<string, unknown>;
  const run = parseSyncRunUpsert(value.run);
  if (run instanceof Response) return run;
  if (!Array.isArray(value.events)) return badRequest("events must be array");
  if (value.events.length > maxEventBatchEvents) return badRequest("events batch is too large");
  const events: RemoteEventInput[] = [];
  const seenSequences = new Set<number>();
  for (const rawEvent of value.events) {
    const event = parseRemoteEvent(rawEvent);
    if (event instanceof Response) return event;
    if (seenSequences.has(event.sequence)) return badRequest("event.sequence is duplicated");
    seenSequences.add(event.sequence);
    events.push(event);
  }
  return { run, events };
}

export function parseFeedMetadataUpsert(body: unknown): FeedMetadataUpsertRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed metadata body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  if (!isProvider(value.provider)) return badRequest("provider is invalid");
  if (!nonEmptyString(value.source_url)) return badRequest("source_url is required");
  if (!nonEmptyString(value.reported_at) || !validDateString(value.reported_at)) {
    return badRequest("reported_at is invalid");
  }
  if (value.last_source_update_at !== undefined && (!nonEmptyString(value.last_source_update_at) || !validDateString(value.last_source_update_at))) {
    return badRequest("last_source_update_at is invalid");
  }
  if (value.explicit !== undefined && typeof value.explicit !== "boolean") {
    return badRequest("explicit must be boolean");
  }

  const request: FeedMetadataUpsertRequest = {
    feed_id: value.feed_id,
    provider: value.provider,
    source_url: value.source_url,
    reported_at: value.reported_at,
  };
  const title = optionalString(value.title);
  if (title !== undefined) request.title = title;
  const description = optionalString(value.description);
  if (description !== undefined) request.description = description;
  const imageURL = optionalString(value.image_url);
  if (imageURL !== undefined) request.image_url = imageURL;
  const link = optionalString(value.link);
  if (link !== undefined) request.link = link;
  const author = optionalString(value.author);
  if (author !== undefined) request.author = author;
  const category = optionalString(value.category);
  if (category !== undefined) request.category = category;
  const language = optionalString(value.language);
  if (language !== undefined) request.language = language;
  if (typeof value.explicit === "boolean") request.explicit = value.explicit;
  const lastSourceUpdateAt = optionalString(value.last_source_update_at);
  if (lastSourceUpdateAt !== undefined) request.last_source_update_at = lastSourceUpdateAt;
  return request;
}

function optionalNullableString(value: unknown, name: string, maxLength = maxFeedStringLength): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return badRequest(`${name} must be string or null`);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > maxLength) return badRequest(`${name} is too long`);
  return trimmed;
}

function requiredBoolean(value: unknown, name: string): boolean | Response {
  if (typeof value !== "boolean") return badRequest(`${name} must be boolean`);
  return value;
}

function integerInRange(value: unknown, name: string, min: number, max: number): number | Response {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < min || value > max) {
    return badRequest(`${name} is invalid`);
  }
  return value;
}

function optionalFilterInteger(value: unknown, name: string): number | null | Response {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    return badRequest(`${name} is invalid`);
  }
  return value;
}

function parseFeedFilters(value: unknown): AdminFeedFilters | Response {
  if (value === undefined || value === null) {
    return emptyFeedFilters();
  }
  if (typeof value !== "object" || Array.isArray(value)) return badRequest("filters must be object");
  const filters = value as Record<string, unknown>;
  const title = optionalNullableString(filters.title, "filters.title");
  if (title instanceof Response) return title;
  const notTitle = optionalNullableString(filters.not_title, "filters.not_title");
  if (notTitle instanceof Response) return notTitle;
  const description = optionalNullableString(filters.description, "filters.description");
  if (description instanceof Response) return description;
  const notDescription = optionalNullableString(filters.not_description, "filters.not_description");
  if (notDescription instanceof Response) return notDescription;
  const minDuration = optionalFilterInteger(filters.min_duration, "filters.min_duration");
  if (minDuration instanceof Response) return minDuration;
  const maxDuration = optionalFilterInteger(filters.max_duration, "filters.max_duration");
  if (maxDuration instanceof Response) return maxDuration;
  const minAge = optionalFilterInteger(filters.min_age, "filters.min_age");
  if (minAge instanceof Response) return minAge;
  const maxAge = optionalFilterInteger(filters.max_age, "filters.max_age");
  if (maxAge instanceof Response) return maxAge;

  return {
    title,
    not_title: notTitle,
    description,
    not_description: notDescription,
    min_duration: minDuration,
    max_duration: maxDuration,
    min_age: minAge,
    max_age: maxAge,
  };
}

function emptyFeedFilters(): AdminFeedFilters {
  return {
    title: null,
    not_title: null,
    description: null,
    not_description: null,
    min_duration: null,
    max_duration: null,
    min_age: null,
    max_age: null,
  };
}

function hostMatchesRoot(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function providerURLIsValid(provider: AdminFeedConfigUpsertRequest["provider"], rawURL: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (provider === "youtube") return hostMatchesRoot(host, "youtube.com");
  return hostMatchesRoot(host, "bilibili.com");
}

function parseBilibiliOptions(
  provider: AdminFeedConfigUpsertRequest["provider"],
  rawOptions: unknown,
): AdminFeedConfigUpsertRequest["bilibili"] | Response {
  if (rawOptions === undefined || rawOptions === null) {
    return { include_upower_exclusive: false };
  }
  if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    return badRequest("bilibili is invalid");
  }
  const value = rawOptions as Record<string, unknown>;
  const includeUpowerExclusive = value.include_upower_exclusive === undefined
    ? false
    : requiredBoolean(value.include_upower_exclusive, "bilibili.include_upower_exclusive");
  if (includeUpowerExclusive instanceof Response) return includeUpowerExclusive;
  if (provider !== "bilibili" && includeUpowerExclusive) {
    return badRequest("bilibili.include_upower_exclusive is only valid for Bilibili feeds");
  }
  return { include_upower_exclusive: provider === "bilibili" ? includeUpowerExclusive : false };
}

export function parseAdminFeedConfigUpsert(body: unknown): AdminFeedConfigUpsertRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed config body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id) || value.feed_id.length > maxFeedIDLength || !feedIDPattern.test(value.feed_id)) {
    return badRequest("feed_id is invalid");
  }
  if (!isProvider(value.provider)) return badRequest("provider is invalid");
  if (!nonEmptyString(value.url)) return badRequest("url is invalid");
  const feedURL = value.url.trim();
  if (feedURL.length > maxFeedURLLength || !providerURLIsValid(value.provider, feedURL)) {
    return badRequest("url is invalid");
  }
  const titleOverride = optionalNullableString(value.title_override, "title_override");
  if (titleOverride instanceof Response) return titleOverride;
  const descriptionOverride = optionalNullableString(value.description_override, "description_override");
  if (descriptionOverride instanceof Response) return descriptionOverride;
  const enabled = requiredBoolean(value.enabled, "enabled");
  if (enabled instanceof Response) return enabled;
  const includeInOpml = requiredBoolean(value.include_in_opml, "include_in_opml");
  if (includeInOpml instanceof Response) return includeInOpml;
  const privateFeed = requiredBoolean(value.private_feed, "private_feed");
  if (privateFeed instanceof Response) return privateFeed;
  if (!nonEmptyString(value.update_period) || value.update_period.length > maxUpdatePeriodLength || !goDurationPattern.test(value.update_period)) {
    return badRequest("update_period is invalid");
  }
  const pageSize = integerInRange(value.page_size, "page_size", 1, maxPageSize);
  if (pageSize instanceof Response) return pageSize;
  const keepLast = integerInRange(value.keep_last, "keep_last", 0, maxKeepLast);
  if (keepLast instanceof Response) return keepLast;
  const cookieProfile = optionalNullableString(value.cookie_profile, "cookie_profile");
  if (cookieProfile instanceof Response) return cookieProfile;
  const bilibili = parseBilibiliOptions(value.provider, value.bilibili);
  if (bilibili instanceof Response) return bilibili;
  const filters = parseFeedFilters(value.filters);
  if (filters instanceof Response) return filters;

  return {
    feed_id: value.feed_id,
    provider: value.provider,
    url: feedURL,
    title_override: titleOverride,
    description_override: descriptionOverride,
    enabled,
    include_in_opml: includeInOpml,
    private_feed: privateFeed,
    update_period: value.update_period,
    page_size: pageSize,
    keep_last: keepLast,
    cookie_profile: cookieProfile,
    bilibili,
    filters,
  };
}

export function parseAdminFeedStatus(body: unknown): AdminFeedStatusRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed status body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  if (value.enabled === undefined && value.include_in_opml === undefined) {
    return badRequest("enabled or include_in_opml is required");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return badRequest("enabled must be boolean");
  }
  if (value.include_in_opml !== undefined && typeof value.include_in_opml !== "boolean") {
    return badRequest("include_in_opml must be boolean");
  }
  const request: AdminFeedStatusRequest = { feed_id: value.feed_id };
  if (value.enabled !== undefined) request.enabled = value.enabled;
  if (value.include_in_opml !== undefined) request.include_in_opml = value.include_in_opml;
  return request;
}

export function parseAdminFeedDelete(body: unknown): AdminFeedDeleteRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed delete body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  return { feed_id: value.feed_id };
}

function isAdminEpisodeAction(value: unknown): value is AdminEpisodeAction {
  return value === "hide" || value === "delete" || value === "restore";
}

export function parseAdminEpisodeStatus(body: unknown): AdminEpisodeStatusRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid episode status body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  if (!nonEmptyString(value.local_episode_id)) return badRequest("local_episode_id is required");
  if (!isAdminEpisodeAction(value.action)) return badRequest("action is invalid");
  return {
    feed_id: value.feed_id,
    local_episode_id: value.local_episode_id,
    action: value.action,
  };
}


export function parseIntegerParam(value: string | null, fallback: number, name: string): number | Response {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return badRequest(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return badRequest(`${name} is invalid`);
  return parsed;
}


export function parseEpisodeStatusParam(value: string | null): EpisodeStatus | Response | null {
  if (value === null || value === "") return null;
  if (value === "pending" || value === "visible" || value === "hidden" || value === "delete_pending" || value === "purged") {
    return value;
  }
  return badRequest("status is invalid");
}

export function adminListLimit(url: URL, fallback: number, max: number): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), fallback, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > max) return badRequest("limit is invalid");
  return limit;
}

export function adminListOffset(url: URL): number | Response {
  return parseIntegerParam(url.searchParams.get("offset"), 0, "offset");
}

export function tombstoneLimit(url: URL): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), 100, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > 500) return badRequest("limit is invalid");
  return limit;
}

