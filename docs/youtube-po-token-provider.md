# YouTube PO Token provider

The Docker image carries a pinned BgUtils PO Token provider plugin at
`/opt/podsync/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip`. The plugin is
inactive by default so regular image users do not get a dependency on a local
provider server.

Use this integration only for deployments that also run the matching provider
sidecar. A PO Token can help with YouTube HTTP 403 responses, but it does not
guarantee that every bot check or media request will succeed.

## Compose integration

Merge [`deploy/nas/compose.youtube-po-token.yml`](../deploy/nas/compose.youtube-po-token.yml)
into the deployment Compose configuration. The overlay:

- enables the plugin for Podsync through `PYTHONPATH`;
- starts the matching `2.0.2-deno` provider image;
- puts Podsync and the provider on a dedicated ordinary bridge while keeping
  the provider off the default application network;
- does not publish port `4416` to the host;
- disables provider log persistence because normal 2.0.2 messages can include
  request-bound identifiers that should not be retained;
- waits for the provider `/ping` endpoint before starting Podsync.

Do not add a host `ports` mapping for the provider. Keep the dedicated bridge
non-internal so the provider retains the DNS and HTTPS egress needed to mint
tokens. Do not replace it with shared network namespace mode: Podsync only
needs ordinary bridge access to the provider service name.

Use the health check, container state, restart count, and Podsync-side error
categories for normal monitoring. Do not retain raw provider request logs.

## yt-dlp arguments

Each YouTube feed must pass both extractor arguments:

```toml
youtube_dl_args = [
  "--format", "18/best[protocol=https][vcodec!=none][acodec!=none]",
  "--extractor-args", "youtube:player_client=mweb",
  "--extractor-args", "youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416",
]
```

The Cloudflare remote control plane in this repository adds these arguments to
generated YouTube feed configuration while preserving the existing timeout and
retry values. The format selector prefers YouTube's progressive format 18 and
falls back to another combined HTTPS format so audio feeds avoid the DASH media
URLs that returned HTTP 403 on the production NAS. It does not add these
arguments to non-YouTube feeds.

The default `fetch_pot=auto` policy is intentional. Use `pot_trace=true` only
for a bounded canary investigation; do not keep it in normal configuration.

## Verification

1. Confirm the provider is healthy and reports the same version as the plugin.
2. Run yt-dlp with `--verbose` and confirm it lists `bgutil:http-2.0.2`.
3. Confirm containers on the default application network cannot resolve or
   connect to `bgutil-provider`, while Podsync can connect over the dedicated
   bridge and the provider can reach required external HTTPS endpoints.
4. Verify a complete progressive-format download and audio transcode; a short
   read alone is insufficient because DASH requests may fail later in the file.
5. Verify one complete Podsync download, transcode, upload, RSS update, and sync
   success event.
6. Observe two scheduled cycles and confirm there are no new YouTube HTTP 403
   failures.

Podsync `/health` alone is not evidence that YouTube media downloads work.

## Rollback

Remove the mweb/provider extractor arguments first. Then remove `PYTHONPATH`
and the `bgutil-provider` service if the provider is no longer needed. This
integration does not require a database migration.
