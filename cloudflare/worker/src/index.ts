import { hasCloudflareAccessIdentity, isAuthorizedNasRequest } from "./auth";
import type {
  AdminEpisodeAction,
  AdminEpisodeListRow,
  AdminEpisodeStatusRequest,
  AdminEventRow,
  AdminFeedConfigUpsertRequest,
  AdminFeedDeleteRequest,
  AdminFeedFilters,
  AdminFeedListRow,
  AdminFeedStatusRequest,
  AdminSubscriptionFeedRow,
  AdminSubscriptionOpmlRow,
  AdminSyncRunRow,
  DownloaderDefaults,
  EpisodeAdminRow,
  EpisodeStatus,
  EpisodeStatusRow,
  EpisodeUpsertRequest,
  EventBatchRequest,
  EventLevel,
  FeedStatusRow,
  FeedMetadataUpsertRequest,
  FeedTomlRow,
  MaxSequenceRow,
  PublicEpisodeRow,
  PublicFeedRow,
  PublicOpmlFeedRow,
  RemoteEventInput,
  RemoteEventType,
  SyncRunStatus,
  SyncRunUpsertRequest,
  TombstoneChangeRow,
} from "./db";
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
const publicPathTokenPattern = /^[A-Za-z0-9_-]+$/;
const maxEventBatchEvents = 100;
const maxRunIDLength = 128;
const maxEventTypeLength = 64;
const maxEventMessageLength = 512;
const maxEventCodeLength = 128;
const maxEventDetailLength = 2048;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const eventRetentionDays = 30;
const syncRunRetentionDays = 180;
const purgeBatchLimit = 50;
const maxFeedIDLength = 128;
const maxFeedStringLength = 512;
const maxFeedURLLength = 2048;
const maxUpdatePeriodLength = 64;
const maxPageSize = 200;
const maxKeepLast = 1000;
const publicFeedTokenAttempts = 5;
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

interface PurgeCandidateRow {
  feed_id: string;
  local_episode_id: string;
  r2_key: string | null;
}

export interface MaintenanceResult {
  old_events_deleted: number;
  old_sync_runs_deleted: number;
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

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function dashboardHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
}

function dashboardHTML(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Podsync Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --panel-soft: #f0f3f6;
      --line: #d7dde4;
      --text: #18212c;
      --muted: #687481;
      --accent: #176f6b;
      --accent-strong: #0f5652;
      --warn: #9a5b00;
      --danger: #a33434;
      --ok: #22714f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      padding: 6px 10px;
    }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-strong); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    button.danger { color: var(--danger); }
    a { color: var(--accent-strong); }
    main {
      min-height: 100vh;
      padding: 20px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    .title h1 {
      font-size: 24px;
      line-height: 1.2;
      margin: 0;
    }
    .title p {
      margin: 4px 0 0;
      color: var(--muted);
    }
    .status {
      min-height: 22px;
      color: var(--muted);
      text-align: right;
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 12px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 22px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.4fr);
      gap: 16px;
      align-items: start;
    }
    .lower {
      display: grid;
      grid-template-columns: minmax(280px, 0.9fr) minmax(300px, 0.8fr) minmax(360px, 1.1fr);
      gap: 16px;
      margin-top: 16px;
      align-items: start;
    }
    section {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      min-width: 0;
    }
    section header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
      border-radius: 8px 8px 0 0;
    }
    section h2 {
      font-size: 15px;
      margin: 0;
    }
    .section-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .feed-form {
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      display: grid;
      gap: 12px;
      background: #ffffff;
    }
    .feed-form[hidden] { display: none; }
    .feed-form-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .feed-form-title strong { font-size: 14px; }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .form-field {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .form-field.wide { grid-column: 1 / -1; }
    .form-field label,
    .form-group-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .form-field input,
    .form-field select,
    .form-field textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 8px;
      background: #ffffff;
      color: var(--text);
    }
    .form-field textarea {
      min-height: 58px;
      resize: vertical;
    }
    .check-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .check-row label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text);
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      background: #fbfcfd;
    }
    tbody tr.selected { background: #eaf5f3; }
    tbody tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      background: #ffffff;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.visible { color: var(--ok); border-color: #b7dbc9; }
    .pill.hidden, .pill.delete_pending { color: var(--warn); border-color: #e0c892; }
    .pill.purged { color: var(--danger); border-color: #e0b0b0; }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .empty {
      padding: 16px;
      color: var(--muted);
    }
    .url-list {
      display: grid;
      gap: 8px;
      padding: 12px;
    }
    .url-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .url-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .stack { display: grid; gap: 4px; min-width: 0; }
    .nowrap { white-space: nowrap; }
    @media (max-width: 980px) {
      main { padding: 14px; }
      .summary, .layout, .lower { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .status { text-align: left; }
    }
  </style>
</head>
<body>
  <main id="app" data-dashboard-app>
    <div class="topbar">
      <div class="title">
        <h1>Podsync Control</h1>
        <p>Remote feeds, subscriptions, episode visibility, and recent NAS activity.</p>
      </div>
      <div class="section-tools">
        <button id="refresh-dashboard" class="primary" type="button">Refresh</button>
        <div id="dashboard-status" class="status" role="status" aria-live="polite">Loading...</div>
      </div>
    </div>

    <div class="summary" aria-label="Summary">
      <div class="metric"><span>Feeds</span><strong id="metric-feeds">-</strong></div>
      <div class="metric"><span>Enabled</span><strong id="metric-enabled">-</strong></div>
      <div class="metric"><span>In OPML</span><strong id="metric-opml">-</strong></div>
      <div class="metric"><span>Latest Run</span><strong id="metric-run">-</strong></div>
    </div>

    <div class="layout">
      <section data-region="feeds" aria-labelledby="feeds-title">
        <header>
          <h2 id="feeds-title">Feeds</h2>
          <div class="section-tools">
            <span id="selected-feed-label" class="muted">No feed selected</span>
            <button id="new-feed" type="button">New</button>
          </div>
        </header>
        <form id="feed-form" class="feed-form" data-feed-form hidden>
          <div class="feed-form-title">
            <strong id="feed-form-title">New feed</strong>
            <div class="section-tools">
              <button id="feed-form-save" class="primary" type="submit">Save</button>
              <button id="feed-form-cancel" type="button">Cancel</button>
            </div>
          </div>
          <div class="form-grid">
            <div class="form-field">
              <label for="feed-id">Feed ID</label>
              <input id="feed-id" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-provider">Provider</label>
              <select id="feed-provider">
                <option value="youtube">youtube</option>
                <option value="bilibili">bilibili</option>
              </select>
            </div>
            <div class="form-field wide">
              <label for="feed-url">URL</label>
              <input id="feed-url" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-title-override">Title override</label>
              <input id="feed-title-override" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-cookie-profile">Cookie profile</label>
              <input id="feed-cookie-profile" type="text" autocomplete="off">
            </div>
            <div class="form-field wide">
              <label for="feed-description-override">Description override</label>
              <textarea id="feed-description-override"></textarea>
            </div>
            <div class="form-field">
              <label for="feed-update-period">Update period</label>
              <input id="feed-update-period" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-page-size">Page size</label>
              <input id="feed-page-size" type="number" min="1" step="1">
            </div>
            <div class="form-field">
              <label for="feed-keep-last">Keep last</label>
              <input id="feed-keep-last" type="number" min="0" step="1">
            </div>
            <div class="form-field wide">
              <span class="form-group-label">Publication</span>
              <div class="check-row">
                <label><input id="feed-enabled" type="checkbox"> Enabled</label>
                <label><input id="feed-include-in-opml" type="checkbox"> OPML</label>
                <label><input id="feed-private-feed" type="checkbox"> Private feed</label>
              </div>
            </div>
            <div class="form-field">
              <label for="feed-filter-title">Filter title</label>
              <input id="feed-filter-title" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-filter-not-title">Filter not title</label>
              <input id="feed-filter-not-title" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-filter-description">Filter description</label>
              <input id="feed-filter-description" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-filter-not-description">Filter not description</label>
              <input id="feed-filter-not-description" type="text" autocomplete="off">
            </div>
            <div class="form-field">
              <label for="feed-filter-min-duration">Min duration</label>
              <input id="feed-filter-min-duration" type="number" min="0" step="1">
            </div>
            <div class="form-field">
              <label for="feed-filter-max-duration">Max duration</label>
              <input id="feed-filter-max-duration" type="number" min="0" step="1">
            </div>
            <div class="form-field">
              <label for="feed-filter-min-age">Min age</label>
              <input id="feed-filter-min-age" type="number" min="0" step="1">
            </div>
            <div class="form-field">
              <label for="feed-filter-max-age">Max age</label>
              <input id="feed-filter-max-age" type="number" min="0" step="1">
            </div>
          </div>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width: 34%">Feed</th>
                <th style="width: 14%">Provider</th>
                <th style="width: 14%">Enabled</th>
                <th style="width: 14%">OPML</th>
                <th style="width: 24%">Subscription</th>
              </tr>
            </thead>
            <tbody id="feeds-body"></tbody>
          </table>
        </div>
      </section>

      <section data-region="episodes" aria-labelledby="episodes-title">
        <header>
          <h2 id="episodes-title">Episodes</h2>
          <div class="section-tools">
            <select id="episode-status-filter" aria-label="Episode status filter">
              <option value="">All statuses</option>
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
              <option value="delete_pending">Delete pending</option>
              <option value="purged">Purged</option>
              <option value="pending">Pending</option>
            </select>
            <button id="refresh-episodes" type="button">Reload</button>
          </div>
        </header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width: 36%">Episode</th>
                <th style="width: 14%">Status</th>
                <th style="width: 18%">Time</th>
                <th style="width: 12%">Media</th>
                <th style="width: 20%">Actions</th>
              </tr>
            </thead>
            <tbody id="episodes-body"></tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="lower">
      <section data-region="subscriptions" aria-labelledby="subscriptions-title">
        <header><h2 id="subscriptions-title">Subscriptions</h2></header>
        <div class="url-list">
          <div>
            <div class="muted">Feed URLs</div>
            <div id="subscription-feeds" class="stack"></div>
          </div>
          <div>
            <div class="muted">OPML URLs</div>
            <div id="subscription-opml" class="stack"></div>
          </div>
        </div>
      </section>

      <section data-region="runs" aria-labelledby="runs-title">
        <header><h2 id="runs-title">Recent Runs</h2></header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Run</th><th>Status</th><th>Counts</th></tr>
            </thead>
            <tbody id="runs-body"></tbody>
          </table>
        </div>
      </section>

      <section data-region="events" aria-labelledby="events-title">
        <header><h2 id="events-title">Recent Events</h2></header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Event</th><th>Target</th><th>Detail</th></tr>
            </thead>
            <tbody id="events-body"></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>

  <script>
    (function () {
      "use strict";

      var paths = {
        feeds: "/api/admin/feeds",
        subscriptions: "/api/admin/subscriptions",
        episodes: "/api/admin/episodes",
        feedUpsert: "/api/admin/feeds/upsert",
        feedStatus: "/api/admin/feeds/status",
        feedDelete: "/api/admin/feeds/delete",
        episodeStatus: "/api/admin/episodes/status",
        syncRuns: "/api/admin/sync-runs?limit=10",
        events: "/api/admin/events?limit=25"
      };

      var state = {
        feeds: [],
        subscriptions: { feeds: [], opml: [] },
        episodes: [],
        syncRuns: [],
        events: [],
        selectedFeedID: "",
        episodeStatus: "",
        feedFormOpen: false,
        feedFormMode: "create",
        editingFeedID: "",
        busy: false
      };

      var feedFormFieldIDs = [
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
        "feed-filter-max-age"
      ];

      function byID(id) {
        return document.getElementById(id);
      }

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      function setStatus(message, kind) {
        var node = byID("dashboard-status");
        node.className = "status" + (kind ? " " + kind : "");
        node.textContent = message;
      }

      function showError(error) {
        setStatus(error instanceof Error ? error.message : String(error), "error");
      }

      async function api(path, options) {
        var init = options || {};
        var headers = Object.assign({ accept: "application/json" }, init.headers || {});
        var response = await fetch(path, Object.assign({}, init, { headers: headers }));
        if (!response.ok) {
          var detail = await response.text();
          throw new Error(detail || ("HTTP " + response.status + " for " + path));
        }
        return response.json();
      }

      function postJSON(path, body) {
        return api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      }

      function setBusy(value) {
        state.busy = value;
        byID("refresh-dashboard").disabled = value;
        byID("refresh-episodes").disabled = value || !state.selectedFeedID;
        byID("new-feed").disabled = value;
        byID("feed-form-save").disabled = value || !state.feedFormOpen;
        byID("feed-form-cancel").disabled = value;
      }

      function emptyRow(colspan, message) {
        var row = el("tr");
        var cell = el("td", "empty", message);
        cell.colSpan = colspan;
        row.appendChild(cell);
        return row;
      }

      function appendCell(row, childOrText, className) {
        var cell = el("td", className || "");
        if (childOrText instanceof Node) {
          cell.appendChild(childOrText);
        } else if (childOrText !== undefined && childOrText !== null) {
          cell.textContent = String(childOrText);
        }
        row.appendChild(cell);
        return cell;
      }

      function formatDate(value) {
        if (!value) return "-";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function formatBytes(value) {
        if (!value || value <= 0) return "-";
        var units = ["B", "KB", "MB", "GB"];
        var size = Number(value);
        var unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
          size = size / 1024;
          unit++;
        }
        return size.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
      }

      function safeExternalURL(value) {
        if (!value) return "";
        try {
          var url = new URL(value, window.location.origin);
          if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
        } catch (error) {
          return "";
        }
        return "";
      }

      function copyText(value) {
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () {
            setStatus("Copied URL", "ok");
          }).catch(function () {
            fallbackCopy(value);
          });
          return;
        }
        fallbackCopy(value);
      }

      function fallbackCopy(value) {
        var input = document.createElement("input");
        input.value = value;
        input.setAttribute("readonly", "readonly");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
        setStatus("Copied URL", "ok");
      }

      function findFeedByID(feedID) {
        return state.feeds.find(function (feed) { return feed.feed_id === feedID; }) || null;
      }

      function emptyFilters() {
        return {
          title: null,
          not_title: null,
          description: null,
          not_description: null,
          min_duration: null,
          max_duration: null,
          min_age: null,
          max_age: null
        };
      }

      function defaultFeedFormValues() {
        return {
          feed_id: "",
          provider: "youtube",
          url: "",
          title_override: null,
          description_override: null,
          enabled: true,
          include_in_opml: true,
          private_feed: true,
          update_period: "1h",
          page_size: 25,
          keep_last: 25,
          cookie_profile: null,
          filters: emptyFilters()
        };
      }

      function valueOrDefault(value, fallback) {
        return value === null || value === undefined ? fallback : value;
      }

      function feedFormValuesFromFeed(feed) {
        var filters = feed.filters || {};
        return {
          feed_id: feed.feed_id,
          provider: feed.provider,
          url: feed.url || "",
          title_override: feed.title_override,
          description_override: feed.description_override,
          enabled: Boolean(feed.enabled),
          include_in_opml: Boolean(feed.include_in_opml),
          private_feed: Boolean(feed.private_feed),
          update_period: feed.update_period || "1h",
          page_size: valueOrDefault(feed.page_size, 25),
          keep_last: valueOrDefault(feed.keep_last, 25),
          cookie_profile: feed.cookie_profile,
          filters: {
            title: filters.title,
            not_title: filters.not_title,
            description: filters.description,
            not_description: filters.not_description,
            min_duration: filters.min_duration,
            max_duration: filters.max_duration,
            min_age: filters.min_age,
            max_age: filters.max_age
          }
        };
      }

      function setTextField(id, value) {
        byID(id).value = value === null || value === undefined ? "" : String(value);
      }

      function setCheckField(id, value) {
        byID(id).checked = Boolean(value);
      }

      function setFeedFormValues(feed) {
        var filters = feed.filters || emptyFilters();
        setTextField("feed-id", feed.feed_id);
        setTextField("feed-provider", feed.provider);
        setTextField("feed-url", feed.url);
        setTextField("feed-title-override", feed.title_override);
        setTextField("feed-description-override", feed.description_override);
        setCheckField("feed-enabled", feed.enabled);
        setCheckField("feed-include-in-opml", feed.include_in_opml);
        setCheckField("feed-private-feed", feed.private_feed);
        setTextField("feed-update-period", feed.update_period);
        setTextField("feed-page-size", feed.page_size);
        setTextField("feed-keep-last", feed.keep_last);
        setTextField("feed-cookie-profile", feed.cookie_profile);
        setTextField("feed-filter-title", filters.title);
        setTextField("feed-filter-not-title", filters.not_title);
        setTextField("feed-filter-description", filters.description);
        setTextField("feed-filter-not-description", filters.not_description);
        setTextField("feed-filter-min-duration", filters.min_duration);
        setTextField("feed-filter-max-duration", filters.max_duration);
        setTextField("feed-filter-min-age", filters.min_age);
        setTextField("feed-filter-max-age", filters.max_age);
      }

      function textOrNull(id) {
        var value = byID(id).value.trim();
        return value === "" ? null : value;
      }

      function requiredText(id, label) {
        var value = byID(id).value.trim();
        if (value === "") throw new Error(label + " is required");
        return value;
      }

      function requiredInteger(id, label, min) {
        var raw = byID(id).value.trim();
        if (!/^\\d+$/.test(raw)) throw new Error(label + " must be an integer");
        var value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min) throw new Error(label + " is invalid");
        return value;
      }

      function optionalInteger(id, label) {
        var raw = byID(id).value.trim();
        if (raw === "") return null;
        if (!/^\\d+$/.test(raw)) throw new Error(label + " must be an integer");
        var value = Number(raw);
        if (!Number.isSafeInteger(value)) throw new Error(label + " is invalid");
        return value;
      }

      function readFeedFormValues() {
        var feedID;
        var provider;
        if (state.feedFormMode === "edit") {
          var original = findFeedByID(state.editingFeedID);
          if (!original) throw new Error("Original feed is missing");
          feedID = state.editingFeedID;
          provider = original.provider;
        } else {
          feedID = requiredText("feed-id", "Feed ID");
          provider = byID("feed-provider").value;
        }
        if (provider !== "youtube" && provider !== "bilibili") throw new Error("Provider is invalid");
        return {
          feed_id: feedID,
          provider: provider,
          url: requiredText("feed-url", "URL"),
          title_override: textOrNull("feed-title-override"),
          description_override: textOrNull("feed-description-override"),
          enabled: byID("feed-enabled").checked,
          include_in_opml: byID("feed-include-in-opml").checked,
          private_feed: byID("feed-private-feed").checked,
          update_period: requiredText("feed-update-period", "Update period"),
          page_size: requiredInteger("feed-page-size", "Page size", 1),
          keep_last: requiredInteger("feed-keep-last", "Keep last", 0),
          cookie_profile: textOrNull("feed-cookie-profile"),
          filters: {
            title: textOrNull("feed-filter-title"),
            not_title: textOrNull("feed-filter-not-title"),
            description: textOrNull("feed-filter-description"),
            not_description: textOrNull("feed-filter-not-description"),
            min_duration: optionalInteger("feed-filter-min-duration", "Min duration"),
            max_duration: optionalInteger("feed-filter-max-duration", "Max duration"),
            min_age: optionalInteger("feed-filter-min-age", "Min age"),
            max_age: optionalInteger("feed-filter-max-age", "Max age")
          }
        };
      }

      function renderFeedForm() {
        var form = byID("feed-form");
        form.hidden = !state.feedFormOpen;
        byID("feed-form-title").textContent = state.feedFormMode === "edit" ? "Edit feed" : "New feed";
        var editing = state.feedFormMode === "edit";
        feedFormFieldIDs.forEach(function (id) {
          byID(id).disabled = state.busy;
        });
        byID("feed-id").readOnly = editing;
        byID("feed-provider").disabled = state.busy || editing;
        byID("feed-form-save").disabled = state.busy || !state.feedFormOpen;
        byID("feed-form-cancel").disabled = state.busy;
      }

      function openNewFeedForm() {
        state.feedFormOpen = true;
        state.feedFormMode = "create";
        state.editingFeedID = "";
        setFeedFormValues(defaultFeedFormValues());
        renderFeedForm();
        setStatus("New feed ready");
      }

      function openEditFeedForm(feedID) {
        var feed = findFeedByID(feedID);
        if (!feed) {
          showError("Feed not found");
          return;
        }
        state.feedFormOpen = true;
        state.feedFormMode = "edit";
        state.editingFeedID = feed.feed_id;
        setFeedFormValues(feedFormValuesFromFeed(feed));
        renderFeedForm();
        setStatus("Editing " + feed.feed_id);
      }

      function closeFeedForm() {
        state.feedFormOpen = false;
        state.feedFormMode = "create";
        state.editingFeedID = "";
        renderFeedForm();
      }

      function renderSummary() {
        var enabled = state.feeds.filter(function (feed) { return feed.enabled; }).length;
        var inOpml = state.feeds.filter(function (feed) { return feed.include_in_opml; }).length;
        var latest = state.syncRuns[0];
        byID("metric-feeds").textContent = String(state.feeds.length);
        byID("metric-enabled").textContent = String(enabled);
        byID("metric-opml").textContent = String(inOpml);
        byID("metric-run").textContent = latest ? latest.status : "-";
      }

      function renderFeeds() {
        var body = byID("feeds-body");
        body.replaceChildren();
        if (state.feeds.length === 0) {
          body.appendChild(emptyRow(5, "No feeds configured."));
          byID("selected-feed-label").textContent = "No feed selected";
          return;
        }
        state.feeds.forEach(function (feed) {
          var row = el("tr", feed.feed_id === state.selectedFeedID ? "selected" : "");

          var name = el("button", "", feed.title || feed.feed_id);
          name.type = "button";
          name.title = feed.url || feed.feed_id;
          name.addEventListener("click", function () {
            selectFeed(feed.feed_id);
          });
          var nameStack = el("div", "stack");
          nameStack.appendChild(name);
          nameStack.appendChild(el("span", "mono muted", feed.feed_id));
          appendCell(row, nameStack);
          appendCell(row, el("span", "pill", feed.provider));

          var enabled = document.createElement("input");
          enabled.type = "checkbox";
          enabled.checked = Boolean(feed.enabled);
          enabled.disabled = state.busy;
          enabled.addEventListener("change", function () {
            updateFeedStatus(feed.feed_id, { enabled: enabled.checked });
          });
          appendCell(row, enabled);

          var opml = document.createElement("input");
          opml.type = "checkbox";
          opml.checked = Boolean(feed.include_in_opml);
          opml.disabled = state.busy;
          opml.addEventListener("change", function () {
            updateFeedStatus(feed.feed_id, { include_in_opml: opml.checked });
          });
          appendCell(row, opml);

          var actions = el("div", "actions");
          var copy = el("button", "", "Copy");
          copy.type = "button";
          copy.disabled = !feed.public_feed_url;
          copy.title = feed.public_feed_url || "No public URL";
          copy.addEventListener("click", function () {
            copyText(feed.public_feed_url);
          });
          actions.appendChild(copy);
          var edit = el("button", "", "Edit");
          edit.type = "button";
          edit.disabled = state.busy;
          edit.addEventListener("click", function () {
            openEditFeedForm(feed.feed_id);
          });
          actions.appendChild(edit);
          var del = el("button", "danger", "Delete");
          del.type = "button";
          del.disabled = state.busy;
          del.title = "Remove this feed from remote subscriptions and mark remote episodes for delayed deletion.";
          del.addEventListener("click", function () {
            deleteFeed(feed.feed_id);
          });
          actions.appendChild(del);
          appendCell(row, actions);
          body.appendChild(row);
        });
        var selected = state.feeds.find(function (feed) { return feed.feed_id === state.selectedFeedID; });
        byID("selected-feed-label").textContent = selected ? selected.feed_id : "No feed selected";
      }

      function renderEpisodes() {
        var body = byID("episodes-body");
        body.replaceChildren();
        if (!state.selectedFeedID) {
          body.appendChild(emptyRow(5, "Select a feed to inspect episodes."));
          return;
        }
        if (state.episodes.length === 0) {
          body.appendChild(emptyRow(5, "No episodes match this view."));
          return;
        }
        state.episodes.forEach(function (episode) {
          var row = el("tr");
          var episodeStack = el("div", "stack");
          var title = episode.title || episode.local_episode_id;
          var safeSourceURL = safeExternalURL(episode.source_url);
          if (safeSourceURL) {
            var link = el("a", "", title);
            link.href = safeSourceURL;
            link.rel = "noopener noreferrer";
            link.target = "_blank";
            episodeStack.appendChild(link);
          } else {
            episodeStack.appendChild(el("span", "", title));
          }
          episodeStack.appendChild(el("span", "mono muted", episode.local_episode_id));
          appendCell(row, episodeStack);
          appendCell(row, el("span", "pill " + episode.status, episode.status));
          appendCell(row, formatDate(episode.published_at || episode.updated_at));
          appendCell(row, episode.has_media ? formatBytes(episode.size) : "No media");
          appendCell(row, episodeActions(episode));
          body.appendChild(row);
        });
      }

      function episodeActions(episode) {
        var actions = el("div", "actions");
        var list = [];
        if (episode.status === "pending" || episode.status === "visible") {
          list.push(["hide", "Hide"]);
          list.push(["delete", "Remote delete"]);
        } else if (episode.status === "hidden") {
          list.push(["restore", "Restore"]);
          list.push(["delete", "Remote delete"]);
        } else if (episode.status === "delete_pending") {
          list.push(["restore", "Restore"]);
        }
        if (list.length === 0) {
          actions.appendChild(el("span", "muted", "No actions"));
          return actions;
        }
        list.forEach(function (item) {
          var action = item[0];
          var label = item[1];
          var button = el("button", action === "delete" ? "danger" : "", label);
          button.type = "button";
          if (action === "delete") {
            button.title = "Remote RSS hides immediately; R2 media is purged later. NAS local files are not deleted.";
          }
          button.disabled = state.busy;
          button.addEventListener("click", function () {
            updateEpisodeStatus(episode.local_episode_id, action);
          });
          actions.appendChild(button);
        });
        return actions;
      }

      function renderSubscriptions() {
        renderUrlList(byID("subscription-feeds"), state.subscriptions.feeds || [], "feed_id");
        renderUrlList(byID("subscription-opml"), state.subscriptions.opml || [], "label");
      }

      function renderUrlList(container, rows, labelField) {
        container.replaceChildren();
        if (!rows.length) {
          container.appendChild(el("div", "empty", "No URLs."));
          return;
        }
        rows.forEach(function (row) {
          var wrapper = el("div", "url-row");
          var stack = el("div", "stack");
          stack.appendChild(el("span", "", row.title || row[labelField] || "subscription"));
          stack.appendChild(el("span", "mono muted", row.xml_url));
          var button = el("button", "", "Copy");
          button.type = "button";
          button.addEventListener("click", function () {
            copyText(row.xml_url);
          });
          wrapper.appendChild(stack);
          wrapper.appendChild(button);
          container.appendChild(wrapper);
        });
      }

      function renderRuns() {
        var body = byID("runs-body");
        body.replaceChildren();
        if (!state.syncRuns.length) {
          body.appendChild(emptyRow(3, "No sync runs reported."));
          return;
        }
        state.syncRuns.forEach(function (run) {
          var row = el("tr");
          var runStack = el("div", "stack");
          runStack.appendChild(el("span", "mono", run.id));
          runStack.appendChild(el("span", "muted", formatDate(run.started_at)));
          appendCell(row, runStack);
          appendCell(row, el("span", "pill " + run.status, run.status));
          appendCell(row, "feeds " + run.feeds_updated + " / downloads " + run.episodes_downloaded + " / uploads " + run.episodes_uploaded + " / errors " + run.errors_count);
          body.appendChild(row);
        });
      }

      function renderEvents() {
        var body = byID("events-body");
        body.replaceChildren();
        if (!state.events.length) {
          body.appendChild(emptyRow(3, "No events reported."));
          return;
        }
        state.events.forEach(function (event) {
          var row = el("tr");
          var eventStack = el("div", "stack");
          eventStack.appendChild(el("span", "pill " + event.level, event.level));
          eventStack.appendChild(el("span", "mono muted", event.type));
          appendCell(row, eventStack);
          appendCell(row, [event.feed_id, event.local_episode_id].filter(Boolean).join(" / ") || "-");
          appendCell(row, event.error_detail || event.message || event.error_code || formatDate(event.event_time));
          body.appendChild(row);
        });
      }

      function renderAll() {
        renderSummary();
        renderFeeds();
        renderFeedForm();
        renderEpisodes();
        renderSubscriptions();
        renderRuns();
        renderEvents();
      }

      async function loadDashboard() {
        setBusy(true);
        setStatus("Loading...");
        try {
          var results = await Promise.all([
            api(paths.feeds),
            api(paths.subscriptions),
            api(paths.syncRuns),
            api(paths.events)
          ]);
          state.feeds = results[0].feeds || [];
          state.subscriptions = results[1] || { feeds: [], opml: [] };
          state.syncRuns = results[2].sync_runs || [];
          state.events = results[3].events || [];
          if (!state.selectedFeedID && state.feeds.length > 0) {
            state.selectedFeedID = state.feeds[0].feed_id;
          }
          if (state.selectedFeedID && !state.feeds.some(function (feed) { return feed.feed_id === state.selectedFeedID; })) {
            state.selectedFeedID = state.feeds.length > 0 ? state.feeds[0].feed_id : "";
          }
          await loadEpisodes(false);
          setStatus("Loaded " + new Date().toLocaleTimeString(), "ok");
        } catch (error) {
          showError(error);
          renderAll();
        } finally {
          setBusy(false);
        }
      }

      async function loadEpisodes(showLoading) {
        if (!state.selectedFeedID) {
          state.episodes = [];
          renderAll();
          return;
        }
        if (showLoading) setStatus("Loading episodes...");
        var query = "?feed_id=" + encodeURIComponent(state.selectedFeedID) + "&limit=50";
        if (state.episodeStatus) query += "&status=" + encodeURIComponent(state.episodeStatus);
        try {
          var result = await api(paths.episodes + query);
          state.episodes = result.episodes || [];
          renderAll();
          if (showLoading) setStatus("Episodes loaded", "ok");
        } catch (error) {
          showError(error);
        }
      }

      function selectFeed(feedID) {
        state.selectedFeedID = feedID;
        state.episodes = [];
        renderAll();
        loadEpisodes(true);
      }

      async function submitFeedForm(event) {
        event.preventDefault();
        var payload;
        try {
          payload = readFeedFormValues();
        } catch (error) {
          showError(error);
          return;
        }
        setBusy(true);
        renderFeedForm();
        try {
          var result = await postJSON(paths.feedUpsert, payload);
          var saved = result.feed || payload;
          state.selectedFeedID = saved.feed_id;
          state.feedFormOpen = false;
          state.feedFormMode = "create";
          state.editingFeedID = "";
          await loadDashboard();
          setStatus("Saved feed " + saved.feed_id, "ok");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
          renderFeedForm();
        }
      }

      async function updateFeedStatus(feedID, patch) {
        setBusy(true);
        try {
          await postJSON(paths.feedStatus, Object.assign({ feed_id: feedID }, patch));
          await loadDashboard();
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      async function deleteFeed(feedID) {
        var ok = window.confirm("Delete feed " + feedID + "? This removes it from remote subscriptions and marks remote episodes for delayed R2 purge. NAS local files are not deleted. Continue?");
        if (!ok) return;
        setBusy(true);
        try {
          await postJSON(paths.feedDelete, { feed_id: feedID });
          if (state.selectedFeedID === feedID) {
            state.selectedFeedID = "";
            state.episodes = [];
          }
          await loadDashboard();
          setStatus("Deleted feed " + feedID, "ok");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      async function updateEpisodeStatus(localEpisodeID, action) {
        if (!state.selectedFeedID) return;
        if (action === "delete") {
          var ok = window.confirm("Remote delete hides this episode from remote RSS and schedules delayed R2 purge. NAS local files are not deleted. Continue?");
          if (!ok) return;
        }
        setBusy(true);
        try {
          await postJSON(paths.episodeStatus, {
            feed_id: state.selectedFeedID,
            local_episode_id: localEpisodeID,
            action: action
          });
          await loadEpisodes(true);
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      byID("refresh-dashboard").addEventListener("click", loadDashboard);
      byID("new-feed").addEventListener("click", openNewFeedForm);
      byID("feed-form").addEventListener("submit", submitFeedForm);
      byID("feed-form-cancel").addEventListener("click", closeFeedForm);
      byID("refresh-episodes").addEventListener("click", function () {
        loadEpisodes(true);
      });
      byID("episode-status-filter").addEventListener("change", function (event) {
        state.episodeStatus = event.target.value;
        loadEpisodes(true);
      });

      loadDashboard();
    }());
  </script>
</body>
</html>`;
}

function dashboardResponse(): Response {
  return new Response(dashboardHTML(), {
    status: 200,
    headers: dashboardHeaders(),
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

function validPublicXmlPath(path: string | null, prefix: "/f/" | "/opml/"): path is string {
  if (path === null) return false;
  if (!path.startsWith(prefix) || !path.endsWith(".xml")) return false;
  const token = path.slice(prefix.length, -".xml".length);
  return publicPathTokenPattern.test(token);
}

function absolutePublicURL(request: Request, path: string | null, prefix: "/f/" | "/opml/"): string | null {
  if (!validPublicXmlPath(path, prefix)) return null;
  return new URL(path, new URL(request.url).origin).toString();
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

async function readBoundedJson(request: Request): Promise<unknown | Response> {
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

function nonEmptyString(value: unknown): value is string {
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

function parseEventBatch(body: unknown): EventBatchRequest | Response {
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

function parseFeedMetadataUpsert(body: unknown): FeedMetadataUpsertRequest | Response {
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

function parseAdminFeedConfigUpsert(body: unknown): AdminFeedConfigUpsertRequest | Response {
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
    filters,
  };
}

function parseAdminFeedStatus(body: unknown): AdminFeedStatusRequest | Response {
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

function parseAdminFeedDelete(body: unknown): AdminFeedDeleteRequest | Response {
  if (!body || typeof body !== "object") return badRequest("invalid feed delete body");
  const value = body as Record<string, unknown>;
  if (!nonEmptyString(value.feed_id)) return badRequest("feed_id is required");
  return { feed_id: value.feed_id };
}

function isAdminEpisodeAction(value: unknown): value is AdminEpisodeAction {
  return value === "hide" || value === "delete" || value === "restore";
}

function parseAdminEpisodeStatus(body: unknown): AdminEpisodeStatusRequest | Response {
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

interface EpisodeTransition {
  changed: boolean;
  status: EpisodeStatus;
  action: "hide" | "delete" | "restore";
  conflict?: string;
}

function episodeTransition(current: EpisodeStatus, action: AdminEpisodeAction): EpisodeTransition {
  if (action === "hide") {
    if (current === "hidden") return { changed: false, status: "hidden", action: "hide" };
    if (current === "pending" || current === "visible") return { changed: true, status: "hidden", action: "hide" };
    return { changed: false, status: current, action: "hide", conflict: "episode cannot be hidden from current status" };
  }
  if (action === "delete") {
    if (current === "delete_pending") return { changed: false, status: "delete_pending", action: "delete" };
    if (current === "pending" || current === "visible" || current === "hidden") {
      return { changed: true, status: "delete_pending", action: "delete" };
    }
    return { changed: false, status: current, action: "delete", conflict: "episode cannot be deleted from current status" };
  }
  if (current === "visible") return { changed: false, status: "visible", action: "restore" };
  if (current === "hidden" || current === "delete_pending") return { changed: true, status: "visible", action: "restore" };
  return { changed: false, status: current, action: "restore", conflict: "episode cannot be restored from current status" };
}

function r2KeyBlank(value: string | null): boolean {
  return value === null || value === "";
}

function restoreRequiresR2Head(action: AdminEpisodeAction, episode: EpisodeAdminRow): boolean {
  return action === "restore" && episode.status === "delete_pending" && !r2KeyBlank(episode.r2_key);
}

async function verifyRestorableR2Object(env: Env, action: AdminEpisodeAction, episode: EpisodeAdminRow): Promise<Response | null> {
  if (!restoreRequiresR2Head(action, episode)) return null;
  if (!env.MEDIA_BUCKET) return text("media bucket unavailable", 503);
  try {
    const object = await env.MEDIA_BUCKET.head(episode.r2_key!);
    if (!object) return text("media object not found", 409);
  } catch {
    return text("media object check failed", 502);
  }
  return null;
}

function episodeStatusUpdateSQL(action: AdminEpisodeAction, episode?: EpisodeAdminRow): string {
  if (action === "delete") {
    return `UPDATE episodes
               SET status = 'delete_pending',
                   deleted_at = CURRENT_TIMESTAMP,
                   purge_after = datetime(CURRENT_TIMESTAMP, '+7 days'),
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND status IN ('pending', 'visible', 'hidden')
               AND EXISTS (
                 SELECT 1 FROM feeds
                  WHERE feeds.feed_id = episodes.feed_id
                    AND feeds.deleted_at IS NULL
               )`;
  }
  if (action === "restore") {
    const statusPredicate = episode?.status === "hidden"
      ? "status = 'hidden'"
      : r2KeyBlank(episode?.r2_key ?? null)
        ? "status = 'delete_pending' AND (r2_key IS NULL OR r2_key = '')"
        : "status = 'delete_pending' AND r2_key = ?";
    return `UPDATE episodes
               SET status = 'visible',
                   deleted_at = NULL,
                   purge_after = NULL,
                   updated_at = CURRENT_TIMESTAMP
             WHERE feed_id = ?
               AND local_episode_id = ?
               AND ${statusPredicate}
               AND EXISTS (
                 SELECT 1 FROM feeds
                  WHERE feeds.feed_id = episodes.feed_id
                    AND feeds.deleted_at IS NULL
               )`;
  }
  return `UPDATE episodes
             SET status = 'hidden',
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status IN ('pending', 'visible')
             AND EXISTS (
               SELECT 1 FROM feeds
                WHERE feeds.feed_id = episodes.feed_id
                  AND feeds.deleted_at IS NULL
             )`;
}

function episodeStatusUpdateBindings(action: AdminEpisodeAction, episode: EpisodeAdminRow, feedID: string, localEpisodeID: string): unknown[] {
  const base = [feedID, localEpisodeID];
  if (action === "restore" && episode.status === "delete_pending" && !r2KeyBlank(episode.r2_key)) {
    return [...base, episode.r2_key];
  }
  return base;
}

function syncRunUpsertSQL(): string {
  return `INSERT INTO sync_runs (
            id, started_at, finished_at, status, feeds_updated,
            episodes_downloaded, episodes_uploaded, errors_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            started_at = CASE
              WHEN sync_runs.status = 'running' AND excluded.started_at < sync_runs.started_at THEN excluded.started_at
              ELSE sync_runs.started_at
            END,
            finished_at = CASE
              WHEN sync_runs.status = 'running' THEN excluded.finished_at
              ELSE sync_runs.finished_at
            END,
            status = CASE
              WHEN sync_runs.status = 'running' THEN excluded.status
              ELSE sync_runs.status
            END,
            feeds_updated = max(sync_runs.feeds_updated, excluded.feeds_updated),
            episodes_downloaded = max(sync_runs.episodes_downloaded, excluded.episodes_downloaded),
            episodes_uploaded = max(sync_runs.episodes_uploaded, excluded.episodes_uploaded),
            errors_count = max(sync_runs.errors_count, excluded.errors_count)`;
}

function eventInsertSQL(): string {
  return `INSERT OR IGNORE INTO events (
            run_id, sequence, event_time, level, type, feed_id,
            local_episode_id, message, error_code, error_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function oldEventsDeleteSQL(): string {
  return `DELETE FROM events
           WHERE datetime(event_time) < datetime(?, '-${eventRetentionDays} days')`;
}

function oldSyncRunsDeleteSQL(): string {
  return `DELETE FROM sync_runs
           WHERE status <> 'running'
             AND datetime(COALESCE(finished_at, started_at)) < datetime(?, '-${syncRunRetentionDays} days')`;
}

function purgeCandidatesSQL(): string {
  return `SELECT feed_id, local_episode_id, r2_key
            FROM episodes
           WHERE status = 'delete_pending'
             AND purge_after IS NOT NULL
             AND datetime(purge_after) <= datetime(?)
           ORDER BY datetime(purge_after) ASC, feed_id ASC, local_episode_id ASC
           LIMIT ?`;
}

function purgeEpisodeUpdateSQL(): string {
  return `UPDATE episodes
             SET status = 'purged',
                 purge_after = NULL,
                 updated_at = ?
           WHERE feed_id = ?
             AND local_episode_id = ?
             AND status = 'delete_pending'
             AND (
               (r2_key IS NULL AND ? IS NULL)
               OR r2_key = ?
             )
             AND purge_after IS NOT NULL
             AND datetime(purge_after) <= datetime(?)`;
}

function purgeTombstoneInsertSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT ?, ?, 'purged', 'purge', ?
           WHERE changes() = 1`;
}

function feedMetadataUpsertSQL(): string {
  return `INSERT INTO feed_metadata (
            feed_id, provider, source_url, title, description, image_url, link,
            author, category, language, explicit, last_source_update_at, reported_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM feeds
              WHERE feed_id = ?
                AND deleted_at IS NULL
           )
          ON CONFLICT(feed_id) DO UPDATE SET
            provider = excluded.provider,
            source_url = excluded.source_url,
            title = excluded.title,
            description = excluded.description,
            image_url = excluded.image_url,
            link = excluded.link,
            author = excluded.author,
            category = excluded.category,
            language = excluded.language,
            explicit = excluded.explicit,
            last_source_update_at = excluded.last_source_update_at,
            reported_at = excluded.reported_at
           WHERE EXISTS (
             SELECT 1 FROM feeds
              WHERE feeds.feed_id = feed_metadata.feed_id
                AND feeds.deleted_at IS NULL
           )`;
}

function feedConfigInsertSQL(): string {
  return `INSERT INTO feeds (
            feed_id, provider, url, title_override, description_override,
            enabled, include_in_opml, private_feed, update_period, page_size,
            keep_last, cookie_profile, feed_token_hash, public_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
}

function feedConfigUpdateSQL(): string {
  return `UPDATE feeds
             SET url = ?,
                 title_override = ?,
                 description_override = ?,
                 enabled = ?,
                 include_in_opml = ?,
                 private_feed = ?,
                 update_period = ?,
                 page_size = ?,
                 keep_last = ?,
                 cookie_profile = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND deleted_at IS NULL`;
}

function feedFiltersUpsertSQL(): string {
  return `INSERT INTO feed_filters (
            feed_id, title, not_title, description, not_description,
            min_duration, max_duration, min_age, max_age
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_id) DO UPDATE SET
            title = excluded.title,
            not_title = excluded.not_title,
            description = excluded.description,
            not_description = excluded.not_description,
            min_duration = excluded.min_duration,
            max_duration = excluded.max_duration,
            min_age = excluded.min_age,
            max_age = excluded.max_age`;
}

function feedDeleteCandidateCountSQL(): string {
  return `SELECT COUNT(*) AS candidate_count
            FROM episodes
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

function feedDeleteTombstoneInsertSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT feed_id, local_episode_id, 'delete_pending', 'delete', CURRENT_TIMESTAMP
            FROM episodes
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

function assertPreviousChangesSQL(): string {
  return `INSERT INTO tombstone_changes (feed_id, local_episode_id, status, action, created_at)
          SELECT NULL, NULL, 'delete_pending', 'delete', CURRENT_TIMESTAMP
           WHERE changes() <> ?`;
}

function feedDeleteEpisodeUpdateSQL(): string {
  return `UPDATE episodes
             SET status = 'delete_pending',
                 deleted_at = CURRENT_TIMESTAMP,
                 purge_after = datetime(CURRENT_TIMESTAMP, '+7 days'),
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND status IN ('pending', 'visible', 'hidden')`;
}

function feedDeleteUpdateSQL(): string {
  return `UPDATE feeds
             SET deleted_at = CURRENT_TIMESTAMP,
                 enabled = 0,
                 include_in_opml = 0,
                 public_path = NULL,
                 updated_at = CURRENT_TIMESTAMP
           WHERE feed_id = ?
             AND deleted_at IS NULL`;
}

function parseIntegerParam(value: string | null, fallback: number, name: string): number | Response {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return badRequest(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return badRequest(`${name} is invalid`);
  return parsed;
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
    filters: feed.filters,
    public_feed_url: absolutePublicURL(request, publicPath, "/f/"),
  };
}

function feedFilterBindings(feed: AdminFeedConfigUpsertRequest): unknown[] {
  return [
    feed.feed_id,
    feed.filters.title,
    feed.filters.not_title,
    feed.filters.description,
    feed.filters.not_description,
    feed.filters.min_duration,
    feed.filters.max_duration,
    feed.filters.min_age,
    feed.filters.max_age,
  ];
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

function parseEpisodeStatusParam(value: string | null): EpisodeStatus | Response | null {
  if (value === null || value === "") return null;
  if (value === "pending" || value === "visible" || value === "hidden" || value === "delete_pending" || value === "purged") {
    return value;
  }
  return badRequest("status is invalid");
}

function adminListLimit(url: URL, fallback: number, max: number): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), fallback, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > max) return badRequest("limit is invalid");
  return limit;
}

function adminListOffset(url: URL): number | Response {
  return parseIntegerParam(url.searchParams.get("offset"), 0, "offset");
}

function tombstoneLimit(url: URL): number | Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), 100, "limit");
  if (limit instanceof Response) return limit;
  if (limit < 1 || limit > 500) return badRequest("limit is invalid");
  return limit;
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
            f.cookie_profile, f.feed_token_hash, ff.title, ff.not_title, ff.description,
            ff.not_description, ff.min_duration, ff.max_duration, ff.min_age, ff.max_age
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

async function handleAdminFeeds(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override,
            f.enabled, f.include_in_opml, f.private_feed, f.update_period,
            f.page_size, f.keep_last, f.cookie_profile, f.public_path,
            m.title AS metadata_title, m.description AS metadata_description,
            ff.title, ff.not_title, ff.description, ff.not_description,
            ff.min_duration, ff.max_duration, ff.min_age, ff.max_age
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
       LEFT JOIN feed_filters ff ON ff.feed_id = f.feed_id
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
      enabled: jsonBoolean(feed.enabled),
      include_in_opml: jsonBoolean(feed.include_in_opml),
      private_feed: jsonBoolean(feed.private_feed),
      update_period: feed.update_period,
      page_size: feed.page_size,
      keep_last: feed.keep_last,
      cookie_profile: feed.cookie_profile,
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

  const restoreGuard = await verifyRestorableR2Object(env, parsed.action, episode);
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
  const oldEvents = await env.DB.prepare(oldEventsDeleteSQL()).bind(nowISO).run();
  const oldSyncRuns = await env.DB.prepare(oldSyncRunsDeleteSQL()).bind(nowISO).run();
  const { results: candidates } = await env.DB.prepare(purgeCandidatesSQL()).bind(nowISO, purgeBatchLimit).all<PurgeCandidateRow>();

  const result: MaintenanceResult = {
    old_events_deleted: oldEvents.meta.changes ?? 0,
    old_sync_runs_deleted: oldSyncRuns.meta.changes ?? 0,
    purge_candidates: candidates.length,
    episodes_purged: 0,
    purge_errors: 0,
  };

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

async function purgeEpisodeCandidate(env: Env, candidate: PurgeCandidateRow, nowISO: string): Promise<boolean> {
  const bucket = env.MEDIA_BUCKET;
  if (candidate.r2_key) {
    if (!bucket) return false;
    await bucket.delete(candidate.r2_key);
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
    `SELECT f.feed_id, f.provider, f.url, f.title_override, f.description_override, f.page_size,
            f.deleted_at, m.title, m.description, m.link
       FROM feeds f
       LEFT JOIN feed_metadata m ON m.feed_id = f.feed_id
      WHERE f.feed_token_hash = ?`,
  ).bind(tokenHash).first<PublicFeedRow>();

  if (!feed) return text("not found", 404);
  if (feed.deleted_at) return text("feed deleted", 410);

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
      if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
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
      if (!hasCloudflareAccessIdentity(request)) return text("forbidden", 403);
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
