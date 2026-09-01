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
  --backfill-remote-media-dry-run
docker compose run --rm -v "$PWD/.secrets/retained-media.json:/run/secrets/retained-media.json:ro" podsync \
  --no-banner --config /app/config.toml --backfill-remote-media \
  --backfill-remote-media-key-file /run/secrets/retained-media.json
docker compose -f compose.yaml -f compose.media-origin.yml up -d podsync media media-tunnel
```

Podsync must be stopped while the one-off command opens its Badger database; do not run the migration concurrently with the service.

`failed > 0` or `missing_tasks > 0` is a failed migration, even if other links were created. Use the aggregate `missing_source`, `size_mismatch`, `unsafe_path`, `target_conflict`, and `other_failure` counters to resolve the cause without printing keys, then rerun idempotently.

## Worker configuration

Keep `MEDIA_PUBLIC_BASE_URL` unchanged. Add `MEDIA_ORIGIN_BASE_URL` as a normal variable pointing at the management route plus `/api/remote-media/`. Store all three credentials as Worker secrets:

- `NAS_TOKEN` (the same exact token configured in Podsync `[remote]`)
- `MEDIA_ORIGIN_ACCESS_CLIENT_ID`
- `MEDIA_ORIGIN_ACCESS_CLIENT_SECRET`

During the observation window, leave `MEDIA_BUCKET` bound. When `MEDIA_ORIGIN_BASE_URL` is present, restore HEAD and scheduled purge DELETE use the NAS management route; otherwise they retain the R2 behavior.

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
- management HEAD works only through the Worker/service-token path;
- failed management DELETE leaves D1 `delete_pending`, while successful DELETE removes only the hardlink and permits D1 `purged`.

After changing the production media Tunnel route, observe for at least seven complete days. Track Tunnel restarts, origin 4xx/5xx, Range failures, D1 restore/purge failures, and NAS availability. Only a separate, explicit retirement change may remove the R2 binding or R2 objects.

## Rollback

Point the production media hostname back to R2. Disable `MEDIA_ORIGIN_BASE_URL` so lifecycle calls fall back to `MEDIA_BUCKET`, change `remote_media.type` back to `r2`, and restart only Podsync. Do not remove NAS hardlinks until rollback acceptance is complete.
