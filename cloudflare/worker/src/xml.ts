function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface ChannelMetadata {
  title: string;
  link: string;
  description: string;
}

export function renderEmptyRss(metadata: ChannelMetadata): string {
  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(metadata.title)}</title>
    <link>${escapeXml(metadata.link)}</link>
    <description>${escapeXml(metadata.description)}</description>
    <lastBuildDate>${escapeXml(now)}</lastBuildDate>
    <generator>podsync-cf</generator>
  </channel>
</rss>
`;
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
