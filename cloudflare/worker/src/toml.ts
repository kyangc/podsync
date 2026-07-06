import type { DownloaderDefaults, FeedTomlRow } from "./db";

function quote(value: string): string {
  return JSON.stringify(value);
}

function line(key: string, value: string | number | boolean): string {
  if (typeof value === "string") return `${key} = ${quote(value)}`;
  return `${key} = ${String(value)}`;
}

function filterValue(key: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value === "") return null;
  return `${key} = ${typeof value === "string" ? quote(value) : value}`;
}

function filtersLine(feed: FeedTomlRow): string | null {
  const filters = [
    filterValue("title", feed.title),
    filterValue("not_title", feed.not_title),
    filterValue("description", feed.description),
    filterValue("not_description", feed.not_description),
    filterValue("min_duration", feed.min_duration),
    filterValue("max_duration", feed.max_duration),
    filterValue("min_age", feed.min_age),
    filterValue("max_age", feed.max_age),
  ].filter((value): value is string => value !== null);

  if (filters.length === 0) return null;
  return `filters = { ${filters.join(", ")} }`;
}

export function compileFeedsToml(feeds: FeedTomlRow[], youtubeDefaults: DownloaderDefaults): string {
  const chunks: string[] = [];

  for (const feed of feeds) {
    if (feed.enabled !== 1) continue;

    chunks.push(`[feeds.${quote(feed.feed_id)}]`);
    chunks.push(line("url", feed.url));
    chunks.push(line("format", "audio"));
    chunks.push(line("quality", "high"));
    chunks.push(line("page_size", feed.page_size));
    chunks.push(line("update_period", feed.update_period));
    chunks.push(line("opml", feed.include_in_opml === 1));
    chunks.push(line("private_feed", feed.private_feed === 1));
    chunks.push(`clean = { keep_last = ${feed.keep_last} }`);

    if (feed.cookie_profile) {
      chunks.push(line("cookie_profile", feed.cookie_profile));
    }

    const filters = filtersLine(feed);
    if (filters) {
      chunks.push(filters);
    }

    if (feed.provider === "youtube") {
      chunks.push(
        `youtube_dl_args = ["--socket-timeout", "${youtubeDefaults.socket_timeout}", "--retries", "${youtubeDefaults.retries}", "--fragment-retries", "${youtubeDefaults.fragment_retries}"]`,
      );
    }

    chunks.push("");
  }

  return chunks.join("\n").trimEnd() + "\n";
}
