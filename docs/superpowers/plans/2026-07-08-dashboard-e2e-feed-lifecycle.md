# Dashboard E2E Feed Lifecycle Plan

## Goal

Build an isolated end-to-end test path for the remote dashboard/control-plane lifecycle:

1. Create a feed.
2. Seed an episode through the NAS API.
3. Verify exported RSS, OPML, and NAS TOML.
4. Disable the feed.
5. Re-enable the feed.
6. Delete the feed.
7. Verify RSS, OPML, and NAS TOML again.

This first slice should prove the data and export contracts before adding broader browser-click coverage.

## Assumptions

- Tests must never call `https://podsync.kyangc.net` or mutate production data.
- The first slice should run against `worker.fetch` plus `fakeD1`, not a real browser. This keeps it fast, deterministic, and safe for destructive lifecycle actions.
- Seeding episodes is a NAS concern, so the test should use `/api/nas/episodes/upsert`; the dashboard UI does not create downloaded episodes.
- "Disable" and "delete" are different:
  - Disable means the feed is removed from NAS TOML and OPML, but the existing RSS token still serves the feed.
  - Delete means the feed is tombstoned, removed from NAS TOML and OPML, and the old RSS URL returns `410 feed deleted`.

## Success Criteria

- A single lifecycle test proves the full artifact path:
  - `/api/admin/feeds/upsert`
  - `/api/nas/episodes/upsert`
  - `/f/<token>.xml`
  - `/opml/<token>.xml`
  - `/api/nas/config.toml`
  - `/api/admin/feeds/status`
  - `/api/admin/feeds/delete`
- The test data is fully isolated in memory with deterministic IDs and fake public media URLs.
- `npm test -- e2e-feed-lifecycle.test.ts` passes.
- `npm run check` remains green.

## Phase 1: Worker-Level Lifecycle E2E

Target files:

- `cloudflare/worker/test/e2e-feed-lifecycle.test.ts`
- Optional small helper extraction only if duplication becomes noisy:
  - `cloudflare/worker/test/helpers/requests.ts`

Test setup:

- Create a fresh `feedsByID` map.
- Create a fresh `episodesByKey` map.
- Seed a known OPML token in `fakeD1`, for example `/opml/e2e-opml.xml`.
- Use a fake media base URL such as `https://media.example.com`.
- Use deterministic test data:
  - `feed_id`: `e2e-feed`
  - provider: `youtube`
  - feed URL: `https://www.youtube.com/channel/UC-e2e`
  - title override: `E2E Feed`
  - local episode ID: `video-1`
  - R2 key: `audio/e2e-feed/video-1.mp3`

Lifecycle assertions:

1. Create feed through admin upsert.
   - Assert status `200`.
   - Assert `created: true`.
   - Assert `public_feed_url` is generated.
   - Assert `/api/admin/subscriptions` includes the feed XML URL and OPML URL.

2. Seed episode through NAS upsert.
   - Assert status `200`.
   - Assert episode status is `visible`.

3. Verify active exports.
   - RSS returns `200`.
   - RSS contains one `<item>`, episode title, `guid`, `pubDate`, and `enclosure`.
   - OPML returns `200`.
   - OPML contains an outline for `E2E Feed` and the generated feed XML URL.
   - NAS TOML returns `200`.
   - TOML contains `[feeds."e2e-feed"]`, URL, update period, page size, and keep-last values.

4. Disable feed through admin status.
   - Assert status `200`.
   - Assert admin feed state is `enabled: false`.
   - RSS still returns `200` for the existing feed XML URL.
   - OPML no longer contains `E2E Feed`.
   - NAS TOML no longer contains `[feeds."e2e-feed"]`.

5. Re-enable feed through admin status.
   - Assert status `200`.
   - Assert admin feed state is `enabled: true`.
   - RSS returns `200`.
   - OPML contains `E2E Feed` again.
   - NAS TOML contains `[feeds."e2e-feed"]` again.

6. Delete feed through admin delete.
   - Assert status `200`.
   - Assert admin feed list no longer includes `e2e-feed`.
   - RSS old URL returns `410` with `feed deleted`.
   - OPML no longer contains `E2E Feed`.
   - NAS TOML no longer contains `[feeds."e2e-feed"]`.

Implementation notes:

- Keep this as one scenario test rather than many tiny tests. The value is proving the lifecycle contract, not retesting every validator.
- Do not add Playwright in this phase.
- Only extend `fakeD1` if the lifecycle test exposes a missing query branch. Keep any fake extension limited to the exact SQL shape used by the route under test.

## Phase 2: Browser Click E2E Foundation

Start only after Phase 1 is green.

Target files:

- `cloudflare/worker/playwright.config.ts`
- `cloudflare/worker/test/e2e/dashboard-feed-lifecycle.spec.ts`
- `cloudflare/worker/test/e2e/server.ts`

Recommended harness:

- Use a tiny local HTTP server that delegates requests to `worker.fetch` with a fresh `fakeD1` environment per test worker.
- Avoid hitting the deployed Worker.
- Seed episodes through helper API calls in test setup, because the UI itself cannot download audio.

Browser scenario:

1. Open `/dashboard/`.
2. Add a feed through the modal.
3. Verify the new feed appears in the table/card list.
4. Seed an episode through test helper.
5. Open the episode modal and verify the episode appears.
6. Copy/export links through UI paths.
7. Disable, enable, and delete the feed through icon buttons and confirmation dialogs.
8. Use Playwright request API to verify RSS, OPML, and TOML after each state transition.

Commands:

- Add a dedicated script after Playwright is introduced:
  - `npm run e2e`
  - `npm run e2e:headed`

## Phase 3: Broader UI Interaction Coverage

Add these after the lifecycle click path is stable:

- Feed form required-field validation.
- Edit feed modal.
- Feed detail modal.
- Episode list modal.
- Log modal.
- Search and filters.
- Sorting.
- Toasts and confirmation dialogs.
- Modal close by outside click and Escape key.
- Mobile viewport feed cards and episode cards.

Each browser test should either:

- Mutate only its isolated local fake state, or
- Be read-only if it ever points at a deployed environment.

## Verification Ladder

For Phase 1:

```bash
cd cloudflare/worker
npm test -- e2e-feed-lifecycle.test.ts
npm run check
```

For Phase 2 and later:

```bash
cd cloudflare/worker
npm run e2e
npm run check
```

## Non-Goals

- Do not test yt-dlp downloads in this dashboard E2E slice.
- Do not upload to real R2.
- Do not call production dashboard APIs.
- Do not use real Bilibili or YouTube network data.
- Do not change product semantics for disable/delete while adding tests.
