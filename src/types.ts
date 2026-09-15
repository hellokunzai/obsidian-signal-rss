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

/**
 * Outcome of pulling the caches of an older folder into the current one.
 * `feeds: 0` is a success too — it just means there was nothing left to move.
 */
export type CacheMigrationResult =
  | { ok: true; feeds: number; articles: number }
  | { ok: false; message: string };

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
  /**
   * Vault-relative folder holding one JSON file per feed. The read and starred
   * flags, and every extracted full text, live in there, so pointing this
   * somewhere else is a migration rather than a rename: the old folder is
   * remembered in `cacheFolderPrevious` so the user can pull the data across.
   */
  cacheFolder: string;
  /**
   * The folder that was in use before the last switch. Only the "migrate cache"
   * button reads it, which is why it stays out of the settings UI.
   */
  cacheFolderPrevious: string;
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

/**
 * Vault-relative folder the article caches live in. A dot folder, so it stays
 * out of the file explorer and out of Obsidian's index — it is machine state,
 * not notes. Kept next to `DEFAULT_SETTINGS` because it *is* a default value.
 */
export const DEFAULT_CACHE_FOLDER = ".rss-subscribe";

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
  cacheFolder: DEFAULT_CACHE_FOLDER,
  cacheFolderPrevious: "",
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
