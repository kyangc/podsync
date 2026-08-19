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
- starts the matching `1.3.1-deno` provider image;
- keeps port `4416` on the internal Compose network;
- disables provider log persistence because version `1.3.1` prints generated
  tokens to standard output;
- waits for the provider `/ping` endpoint before starting Podsync.

Do not add a host `ports` mapping for the provider.

Do not enable the default Docker log driver for provider version `1.3.1`.
Use the health check, container state, restart count, and Podsync-side errors for
normal monitoring. Re-evaluate this restriction when upgrading the provider.

## yt-dlp arguments

Each YouTube feed must pass both extractor arguments:

```toml
youtube_dl_args = [
  "--extractor-args", "youtube:player_client=mweb",
  "--extractor-args", "youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416",
]
```

The Cloudflare remote control plane in this repository adds these arguments to
generated YouTube feed configuration while preserving the existing timeout and
retry values. It does not add them to non-YouTube feeds.

The default `fetch_pot=auto` policy is intentional. Use `pot_trace=true` only
for a bounded canary investigation; do not keep it in normal configuration.

## Verification

1. Confirm the provider is healthy and reports the same version as the plugin.
2. Run yt-dlp with `--verbose` and confirm it lists `bgutil:http-1.3.1`.
3. Verify a media short read with `mweb+bestaudio`.
4. Verify one complete Podsync download, transcode, upload, RSS update, and sync
   success event.
5. Observe two scheduled cycles and confirm there are no new YouTube HTTP 403
   failures.

Podsync `/health` alone is not evidence that YouTube media downloads work.

## Rollback

Remove the mweb/provider extractor arguments first. Then remove `PYTHONPATH`
and the `bgutil-provider` service if the provider is no longer needed. This
integration does not require a database migration.
