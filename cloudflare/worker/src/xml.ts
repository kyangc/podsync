function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class InvalidMediaBaseURLError extends Error {
  constructor() {
    super("MEDIA_PUBLIC_BASE_URL must be an absolute http(s) URL");
  }
}

export class InvalidR2KeyError extends Error {
  constructor() {
    super("episode r2_key is invalid");
  }
}

export interface ChannelMetadata {
  title: string;
  link: string;
  description: string;
  imageURL?: string | null;
  author?: string | null;
  category?: string | null;
  language?: string | null;
  explicit?: boolean | null;
  privateFeed?: boolean | null;
}

export interface RssEpisode {
  local_episode_id: string;
  source_url: string | null;
  thumbnail: string | null;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration: number | null;
  r2_key: string;
  size: number;
  mime_type: string;
}

export interface RenderRssOptions {
  mediaBaseURL?: string | undefined;
  author?: string | undefined;
  explicit?: boolean | undefined;
}

function parseMediaBaseURL(mediaBaseURL: string | undefined): URL {
  if (!mediaBaseURL) throw new InvalidMediaBaseURLError();
  let base: URL;
  try {
    base = new URL(mediaBaseURL);
  } catch {
    throw new InvalidMediaBaseURLError();
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new InvalidMediaBaseURLError();
  }
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  base.search = "";
  base.hash = "";
  return base;
}

export function validateR2Key(r2Key: string): void {
  if (r2Key.trim() === "" || r2Key.startsWith("/") || r2Key.includes("\\")) {
    throw new InvalidR2KeyError();
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(r2Key)) {
    throw new InvalidR2KeyError();
  }
  const segments = r2Key.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new InvalidR2KeyError();
  }
}

function encodeR2Key(r2Key: string): string {
  validateR2Key(r2Key);
  const segments = r2Key.split("/");
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function episodeMediaURL(mediaBaseURL: string | undefined, r2Key: string): string {
  return new URL(encodeR2Key(r2Key), parseMediaBaseURL(mediaBaseURL)).toString();
}

function normalizeAuthor(author: string | null | undefined, fallback: string): string {
  const normalized = author?.trim();
  if (!normalized || normalized === "<notfound>") return fallback;
  return normalized;
}

function formatItunesDuration(seconds: number): string {
  const duration = Math.floor(seconds);
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const remainingSeconds = duration % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function renderEpisodeItem(episode: RssEpisode, options: RenderRssOptions, index: number): string {
  const title = episode.title ?? episode.local_episode_id;
  const description = episode.description ?? "";
  const pubDate = episode.published_at ? new Date(episode.published_at) : null;
  const author = options.author?.trim();
  const lines = [
    "    <item>",
    `      <title>${escapeXml(title)}</title>`,
    `      <description>${escapeXml(description)}</description>`,
  ];

  if (author) {
    lines.push(`      <itunes:author>${escapeXml(author)}</itunes:author>`);
  }
  lines.push(`      <itunes:subtitle>${escapeXml(title)}</itunes:subtitle>`);
  lines.push(`      <itunes:summary>${escapeXml(description)}</itunes:summary>`);
  if (episode.source_url) {
    lines.push(`      <link>${escapeXml(episode.source_url)}</link>`);
  }
  lines.push(`      <guid isPermaLink="false">${escapeXml(episode.local_episode_id)}</guid>`);
  if (pubDate && !Number.isNaN(pubDate.getTime())) {
    lines.push(`      <pubDate>${escapeXml(pubDate.toUTCString())}</pubDate>`);
  }
  lines.push(
    `      <enclosure url="${escapeXml(episodeMediaURL(options.mediaBaseURL, episode.r2_key))}" length="${escapeXml(String(episode.size))}" type="${escapeXml(episode.mime_type)}" />`,
  );
  const thumbnail = episode.thumbnail?.trim();
  if (thumbnail) {
    lines.push(`      <itunes:image href="${escapeXml(thumbnail)}"></itunes:image>`);
  }
  if (episode.duration !== null && episode.duration > 0) {
    lines.push(`      <itunes:duration>${escapeXml(formatItunesDuration(episode.duration))}</itunes:duration>`);
  }
  lines.push(`      <itunes:explicit>${options.explicit ? "true" : "false"}</itunes:explicit>`);
  lines.push(`      <itunes:order>${escapeXml(String(index + 1))}</itunes:order>`);
  lines.push("    </item>");
  return lines.join("\n");
}

export function renderRss(metadata: ChannelMetadata, episodes: RssEpisode[], options: RenderRssOptions = {}): string {
  const now = new Date().toUTCString();
  const author = normalizeAuthor(metadata.author, metadata.title);
  const category = metadata.category?.trim() || "TV & Film";
  const renderOptions = { ...options, author, explicit: metadata.explicit === true };
  const items = episodes.map((episode, index) => renderEpisodeItem(episode, renderOptions, index)).join("\n");
  const imageURL = metadata.imageURL?.trim();
  const image = imageURL ? `    <image>
      <url>${escapeXml(imageURL)}</url>
      <title>${escapeXml(metadata.title)}</title>
      <link>${escapeXml(metadata.link)}</link>
    </image>
    <itunes:image href="${escapeXml(imageURL)}"></itunes:image>
` : "";
  const language = metadata.language?.trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(metadata.title)}</title>
    <link>${escapeXml(metadata.link)}</link>
    <description>${escapeXml(metadata.description)}</description>
    <itunes:author>${escapeXml(author)}</itunes:author>
    <itunes:subtitle>${escapeXml(metadata.title)}</itunes:subtitle>
    <itunes:summary>${escapeXml(metadata.description)}</itunes:summary>
${metadata.privateFeed ? "    <itunes:block>yes</itunes:block>\n" : ""}    <itunes:explicit>${metadata.explicit ? "true" : "false"}</itunes:explicit>
    <itunes:category text="${escapeXml(category)}"></itunes:category>
${language ? `    <language>${escapeXml(language)}</language>\n` : ""}    <lastBuildDate>${escapeXml(now)}</lastBuildDate>
    <generator>podsync-cf</generator>
${image}${items ? `${items}\n` : ""}  </channel>
</rss>
`;
}

export function renderEmptyRss(metadata: ChannelMetadata): string {
  return renderRss(metadata, []);
}

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
}

export function renderOpml(feeds: OpmlFeed[]): string {
  const outlines = feeds
    .map((feed) => `    <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.xmlUrl)}" />`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Podsync</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}
