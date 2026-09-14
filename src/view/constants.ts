export const VIEW_TYPE_RSS_SUBSCRIBE = "rss-subscribe-view";

/** A second copy of the list column, docked in the right sidebar. */
export const VIEW_TYPE_RSS_SIDEBAR = "rss-subscribe-sidebar";

export type FilterKind = "all" | "unread" | "starred" | "feed";

export type NarrowPane = "list" | "reader";

/**
 * Settings key for the "Ungrouped" bucket in `collapsedGroups`. A real group
 * name is never empty (`FeedStore.groups()` skips falsy ones), so "" is free.
 */
export const UNGROUPED_KEY = "";

/** Width the store treats as "never dragged": the CSS default takes over. */
export const DEFAULT_LIST_WIDTH = 300;

/** Below this the feed titles and their counters start to collide. */
export const MIN_LIST_WIDTH = 180;

/** The reader never shrinks past this, otherwise the column is unreadable. */
export const MIN_READER_WIDTH = 300;

/** Widest the list pane may grow, as a share of the whole view. */
export const MAX_LIST_SHARE = 0.7;

/** Tallest the feed section may grow, as a share of the whole list pane. */
export const MAX_FEED_SHARE = 0.72;

/** 0 means "never dragged": the CSS default ratio (45%) takes over. */
export const DEFAULT_FEED_HEIGHT = 0;

/** One filter row plus its padding — below this only one row is visible. */
export const MIN_FEED_HEIGHT = 88;

/** Enough room for a couple of article rows under the feed section. */
export const MIN_ARTICLE_HEIGHT = 160;
