import { describe, expect, it } from "vitest";
import type { FeedTomlRow } from "../src/db";
import { compileFeedsToml } from "../src/toml";

const youtubeFeed: FeedTomlRow = {
  feed_id: "tangpingshu",
  provider: "youtube",
  url: "https://www.youtube.com/channel/UCrLtQJG-ZNJeU08N0SNIJzw",
  title_override: null,
  description_override: null,
  enabled: 1,
  include_in_opml: 1,
  private_feed: 1,
  update_period: "1h",
  page_size: 25,
  keep_last: 25,
  cookie_profile: null,
  feed_token_hash: "hash",
};

describe("compileFeedsToml", () => {
  it("compiles enabled feeds only and adds YouTube downloader defaults", () => {
    const toml = compileFeedsToml([
      youtubeFeed,
      {
        ...youtubeFeed,
        feed_id: "disabled",
        enabled: 0,
      },
    ], { socket_timeout: 12, retries: 1, fragment_retries: 1 });

    expect(toml).toContain('[feeds."tangpingshu"]');
    expect(toml).toContain('youtube_dl_args = ["--socket-timeout", "12", "--retries", "1", "--fragment-retries", "1"]');
    expect(toml).not.toContain('[feeds."disabled"]');
  });

  it("quotes unusual feed ids and emits Bilibili cookie profile", () => {
    const toml = compileFeedsToml([
      {
        ...youtubeFeed,
        feed_id: "bili.feed-1",
        provider: "bilibili",
        url: "https://space.bilibili.com/10835521",
        cookie_profile: "bilibili-main",
        bilibili_include_upower_exclusive: 1,
      },
    ], { socket_timeout: 12, retries: 1, fragment_retries: 1 });

    expect(toml).toContain('[feeds."bili.feed-1"]');
    expect(toml).toContain('cookie_profile = "bilibili-main"');
    expect(toml).toContain('[feeds."bili.feed-1".bilibili]');
    expect(toml).toContain("include_upower_exclusive = true");
    expect(toml).not.toContain("youtube_dl_args");
  });

  it("emits filters and preserves explicit numeric zeroes", () => {
    const toml = compileFeedsToml([
      {
        ...youtubeFeed,
        not_title: "直播",
        min_duration: 0,
      },
    ], { socket_timeout: 12, retries: 1, fragment_retries: 1 });

    expect(toml).toContain('filters = { not_title = "直播", min_duration = 0 }');
  });
});
