# NAS public-media origin runbook

This runbook migrates the existing public podcast media URLs from R2 to NAS storage behind Cloudflare Tunnel. It deliberately preserves the existing `r2_key` value and `MEDIA_PUBLIC_BASE_URL`, so RSS enclosure URLs do not change.

## Safety boundary

- Public media hostname: unauthenticated `GET`/`HEAD`; do not attach Cloudflare Access.
- Management hostname: Cloudflare Access service-token policy only; route to the Podsync HTTP service, not nginx.
- nginx receives only `data/.remote-media` as a read-only mount. Never mount `db`, `config.toml`, cookies, XML, or the full data directory.
- Keep the Worker R2 binding and R2 objects throughout cutover and for at least seven complete days after production acceptance.
- Do not use `immutable` caching until key immutability is separately guaranteed.

## Topology

```text
public RSS client
  -> media public hostname (no Access)
  -> Cloudflare cache / Tunnel
  -> nginx:8080
  -> data/.remote-media/audio/... hardlink
  -> existing NAS media inode

Worker restore / purge
  -> private management hostname (Access service token)
  -> Tunnel
  -> podsync:9090 /api/remote-media/...
  -> HEAD or unlink of the public hardlink
```

## NAS preparation

Use the media compose file as an override in the existing Podsync Compose project so `media-tunnel` can resolve both `media:8080` and `podsync:9090`:

```sh
mkdir -p data/.remote-media .secrets
chmod 700 .secrets
install -m 600 /path/to/tunnel-token .secrets/media-tunnel-token
chown 65532:65532 .secrets/media-tunnel-token
docker compose -f compose.yaml -f compose.media-origin.yml config
docker compose -f compose.yaml -f compose.media-origin.yml up -d media media-tunnel
```

The checked-in image versions match the already-running Monga media origin on the same NAS. Review and pin by digest before a later independent upgrade; do not silently track `latest`.

The NAS override explicitly uses HTTP/2 over TCP port 7844. The current NAS egress path fails QUIC/UDP handshakes while TCP succeeds. This setting applies only to this connector and retains TLS verification. It does not repair stale Fake-IP mappings in an upstream DNS proxy.

Configure the remotely-managed Tunnel with two routes:

| Route | Origin | Access |
| --- | --- | --- |
| Temporary staging media hostname, then the existing production media hostname | `http://media:8080` | None |
| Private management hostname | `http://podsync:9090` | Service-token policy |

## Podsync configuration

The public directory must already exist. Keep `[r2]` during the observation window for rollback, but select the hardlink publisher:

```toml
[remote_media]
type = "hardlink"
prefix = "audio"
public_root = "/app/data/.remote-media"
```

First export the authoritative retained key set from D1. Retained means `visible`, `hidden`, or `delete_pending`; `purged` keys must never be republished. Keep the generated JSON file private and delete it after acceptance:

```sh
umask 077
raw_file=$(mktemp)
key_file=$(mktemp)
npx wrangler d1 execute podsync-control-plane --remote --json \
  --command "SELECT DISTINCT r2_key FROM episodes WHERE status IN ('visible','hidden','delete_pending') AND r2_key IS NOT NULL AND r2_key <> '' ORDER BY r2_key;" \
  > "$raw_file"
jq '[.[].results[]?.r2_key] | unique' "$raw_file" > "$key_file"
rm "$raw_file"
jq 'length' "$key_file"
```

Securely copy `"$key_file"` to `.secrets/retained-media.json` on the NAS. The bounded migration only selects `succeeded` remote-publish tasks whose exact key is in that JSON array and prints aggregate counts; it does not log object keys:

```sh
docker compose stop podsync
docker compose run --rm -v "$PWD/.secrets/retained-media.json:/run/secrets/retained-media.json:ro" podsync \
  --no-banner --config /app/config.toml --backfill-remote-media \
  --backfill-remote-media-key-file /run/secrets/retained-media.json \
  --backfill-remote-media-recover-missing-from-r2 \
  --backfill-remote-media-dry-run
docker compose run --rm -v "$PWD/.secrets/retained-media.json:/run/secrets/retained-media.json:ro" podsync \
  --no-banner --config /app/config.toml --backfill-remote-media \
  --backfill-remote-media-key-file /run/secrets/retained-media.json \
  --backfill-remote-media-recover-missing-from-r2
docker compose -f compose.yaml -f compose.media-origin.yml up -d podsync media media-tunnel
```

Podsync must be stopped while the one-off command opens its Badger database; do not run the migration concurrently with the service.

With `--backfill-remote-media-recover-missing-from-r2`, dry-run uses R2 HEAD only. The actual run atomically restores only selected missing sources, verifies the exact stored size, and then creates the hardlink. It never overwrites an existing source path.

`failed > 0`, `missing_tasks > 0`, or `recovery_failed > 0` is a failed migration, even if other links were created. Use the aggregate `missing_source`, `size_mismatch`, `unsafe_path`, `target_conflict`, and `other_failure` counters to resolve the cause without printing keys, then rerun idempotently.

## Worker configuration

Keep `MEDIA_PUBLIC_BASE_URL` unchanged. Add `MEDIA_ORIGIN_BASE_URL` as a normal variable pointing at the management route plus `/api/remote-media/`. Store all three credentials as Worker secrets:

- `NAS_TOKEN` (the same exact token configured in Podsync `[remote]`)
- `MEDIA_ORIGIN_ACCESS_CLIENT_ID`
- `MEDIA_ORIGIN_ACCESS_CLIENT_SECRET`

During the observation window, leave `MEDIA_BUCKET` bound. When `MEDIA_ORIGIN_BASE_URL` is present, restore HEAD and scheduled purge DELETE use the NAS management route; otherwise they retain the R2 behavior.

From the NAS, verify the complete Worker -> Access -> Tunnel -> Podsync HEAD path without changing D1:

```sh
curl -fsS -o /dev/null -X POST https://PODSYNC_WORKER/api/nas/media-origin/check \
  -H "Authorization: Bearer $NAS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"r2_key":"audio/RETAINED_KEY.mp3"}'
```

Management lifecycle subrequests must bypass the CDN cache (`Request.cache = "no-store"`). A cacheable `.mp3` HEAD miss can otherwise become GET at Cloudflare's edge and receive 405 from the HEAD/DELETE-only management endpoint. Validate this path separately from public media Range reads; public media caching remains enabled. The local fix and its pending production acceptance are recorded in the [2026-10-21 incident](incidents/2026-10-21-media-tunnel-response-stall.md#管理-head-的独立验收缺口本地修复待部署).

## Acceptance gates

Before public cutover, test representative small, medium, and largest objects on the temporary hostname:

```sh
curl -fsSI https://STAGING_HOST/audio/KEY.mp3
curl -fsS -D - -o /dev/null -H 'Range: bytes=0-1023' https://STAGING_HOST/audio/KEY.mp3
```

Require:

- public access without cookies, Tailscale, Access redirect, or JWT;
- `HEAD` returns 200 with the expected `Content-Length` and MIME type;
- Range returns 206 and exactly 1024 bytes;
- repeat GET/Range shows valid Cloudflare cache behavior without `private`/`no-store`;
- backfill has `failed=0` and `missing_tasks=0`, selected/link counts match the authoritative D1-retained key set, and sampled files share an inode with their source;
- a real external podcast client downloads and seeks successfully;
- the authenticated `/api/nas/media-origin/check` returns 204 through the Worker/service-token path;
- failed management DELETE leaves D1 `delete_pending`, while successful DELETE removes only the hardlink and permits D1 `purged`.

After changing the production media Tunnel route, observe for at least seven complete days. Track Tunnel restarts, origin 4xx/5xx, Range failures, D1 restore/purge failures, and NAS availability. Only a separate, explicit retirement change may remove the R2 binding or R2 objects.

## Rollback

Point the production media hostname back to R2. Disable `MEDIA_ORIGIN_BASE_URL` so lifecycle calls fall back to `MEDIA_BUCKET`, change `remote_media.type` back to `r2`, and restart only Podsync. Do not remove NAS hardlinks until rollback acceptance is complete.

## Tunnel connectivity incidents

A running connector container and a healthy Podsync HTTP service do not establish public media availability. Cloudflare can serve an older cached object while uncached objects fail with 530/1033.

1. Read the connector's internal `/ready` and `/metrics` endpoints from the media container. Require ready connections and a nonzero `cloudflared_tunnel_ha_connections`; do not publish the metrics port. With the current image, the default metrics port is 20241.
2. Compare connection errors and registered-connection addresses with fresh DNS resolution **from the same Docker network**. In a Fake-IP environment, a long-running connector can retain addresses whose proxy mappings are no longer usable. A different answer alone does not prove why the old mapping changed; preserve the failure and fresh-address connectivity evidence.
3. Test TCP and QUIC separately. HTTP/2 also requires port 7844, so success on HTTPS port 443 alone does not prove Tunnel connectivity. Keep HTTP/2 in the NAS override while QUIC remains unavailable.
4. If refreshing stale edge discovery is necessary, restart only `media-tunnel`. For a command/configuration change, save the previous override, validate the merged Compose config, and recreate only that service with `--no-deps --pull never`. Do not restart Podsync, republish media, rotate credentials, or change shared routing as part of this operation.
5. Verify affected new objects and an older object through public RSS, D1 size, and Range requests from both an external client and the NAS. A unique query can exercise an uncached path; confirm a cache MISS and a matching nginx origin access entry. Also verify a read-only authenticated management HEAD, Access protection, background event freshness, and absence of continued connection errors after registration.

To revert a connector transport change, restore the saved override and recreate only `media-tunnel` with the same Compose files and `--no-deps --pull never`; repeat the same acceptance checks. No R2 cutover, media migration, or Podsync restart is needed for this transport rollback.

See the [2026-10-19 incident](incidents/2026-10-19-media-tunnel-connectivity.md) for the observed failure boundary and recovery evidence. Changes to shared Clash DNS, Fake-IP persistence, or egress policies require a separately reviewed scope; HTTP/2 alone does not eliminate that upstream dependency.

Ready connections and a stable request-error counter can also coexist with response backpressure. Compare public `/healthz` with the same hostname's Cloudflare edge response and the internal nginx health endpoint. If only origin-backed public requests stall, capture in-flight requests, socket queues and, when available, a read-only cloudflared goroutine snapshot before refreshing connections. A successful restart resets process counters; verify actual responses and completion of origin transfers separately.

Use unique-query media probes sparingly and wait for the matching nginx transfer to finish before adding more. Cloudflare may fetch the entire object to populate its cache even when the public client requests only 1024 bytes. Several probes can therefore amplify traffic and delay small health responses on a constrained tunnel path. Match the complete origin byte count to D1, then reuse the same URL to check cache behavior. See the [2026-10-21 response-stall incident](incidents/2026-10-21-media-tunnel-response-stall.md) for the observed boundary and remaining uncertainty.
