export interface Feed {
  id: string;
  title: string;
  url: string;
  siteUrl: string;
  group: string;
  addedAt: number;
  lastFetchedAt: number;
  lastError: string;
  includeKeywords: string;
  excludeKeywords: string;
}

export interface Article {
  id: string;
  feedId: string;
  title: string;
  link: string;
  author: string;
  publishedAt: number;
  summary: string;
  content: string;
  fulltext: string;
  fulltextFetchedAt: number;
  fulltextFailed: boolean;
  read: boolean;
  starred: boolean;
  savedPath: string;
}

export interface ParsedItem {
  title: string;
  link: string;
  guid: string;
  author: string;
  publishedAt: number;
  summary: string;
  content: string;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string;
  description: string;
  items: ParsedItem[];
}

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl: string;
  group: string;
}

/** Outcome of a "detect the feed behind this address" attempt. */
export type DiscoverResult =
  | { ok: true; url: string; title: string }
  | { ok: false; message: string; hint: string };

/** Outcome of subscribing to an address. */
export type AddFeedResult =
  | { ok: true; feed: Feed }
  | { ok: false; message: string; hint: string };

export interface RssSubscribeSettings {
  version: number;
  refreshIntervalMinutes: number;
  requestTimeoutSeconds: number;
  maxArticlesPerFeed: number;
  /**
   * Group names the user declared by hand. A group holding at least one feed is
   * derived from those feeds and is not listed here; an empty one has nothing to
   * be derived from, so it exists only as a name until a feed joins it.
   */
  groups: string[];
  /** Group names whose feed rows are folded shut. "" stands for the ungrouped bucket. */
  collapsedGroups: string[];
  markReadOnOpen: boolean;
  fetchFulltextOnOpen: boolean;
  fetchFulltextOnRefresh: boolean;
  readerFontSize: number;
  readerLineHeight: number;
  noteFolder: string;
  noteFilenameTemplate: string;
  frontmatterTemplate: string;
  noteBodyTemplate: string;
  openAfterSave: boolean;
  /** Remembered height of the feed section, in pixels. 0 = never dragged. */
  feedPaneHeight: number;
}

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: RssSubscribeSettings = {
  version: SETTINGS_VERSION,
  refreshIntervalMinutes: 60,
  requestTimeoutSeconds: 20,
  maxArticlesPerFeed: 200,
  groups: [],
  collapsedGroups: [],
  markReadOnOpen: true,
  fetchFulltextOnOpen: true,
  fetchFulltextOnRefresh: false,
  readerFontSize: 16,
  readerLineHeight: 1.7,
  noteFolder: "RSS Inbox",
  noteFilenameTemplate: "{{published:YYYY-MM-DD}} {{title}}",
  frontmatterTemplate: [
    "title: {{title:yaml}}",
    "source: {{link}}",
    "feed: {{feed:yaml}}",
    "author: {{author:yaml}}",
    "published: {{published:YYYY-MM-DD}}",
    "created: {{created:YYYY-MM-DDTHH:mm}}",
    "tags:",
    "  - rss",
  ].join("\n"),
  noteBodyTemplate: ["{{content}}", "", "---", "", "来源：[{{feed}}]({{link}})"].join("\n"),
  openAfterSave: false,
  feedPaneHeight: 0,
};
