import type { App } from "obsidian";
import type { Article, Feed, ParsedFeed } from "../types";
import { DEFAULT_CACHE_FOLDER } from "../types";
import { t } from "../i18n";
import { safeHtml } from "./sanitize";

const MAX_STORED_BODY = 200000;
const MAX_ITEMS_PER_FETCH = 300;

/**
 * Turn whatever the user typed into the vault-relative folder the store uses.
 *
 * The value is typed by hand, so it arrives in every shape: a bare name, a
 * leading slash, backslashes from a copy-paste out of Explorer, `.` noise. All
 * of those collapse to the same path here. `..` resolves rather than being
 * rejected — popping past the vault root leaves nothing, and an empty result
 * falls back to the default instead of the vault root, which would turn the
 * whole vault into the cache folder.
 */
export function cacheFolderPath(value: unknown): string {
  const parts: string[] = [];
  for (const chunk of String(value ?? "").split(/[\\/]+/)) {
    const part = chunk.trim();
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : DEFAULT_CACHE_FOLDER;
}

export function articleId(seed: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + code) | 0;
    h2 = ((h2 << 5) + h2 ^ code) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export function newFeedId(url: string): string {
  return articleId(url.toLowerCase());
}

function cut(value: string): string {
  return value.length > MAX_STORED_BODY ? value.slice(0, MAX_STORED_BODY) : value;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeArticle(raw: Partial<Article> | null | undefined): Article | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(raw.id);
  const feedId = asString(raw.feedId);
  if (!id || !feedId) return null;
  return {
    id,
    feedId,
    title: asString(raw.title),
    link: asString(raw.link),
    author: asString(raw.author),
    publishedAt: asNumber(raw.publishedAt),
    summary: asString(raw.summary),
    content: asString(raw.content),
    fulltext: asString(raw.fulltext),
    fulltextFetchedAt: asNumber(raw.fulltextFetchedAt),
    fulltextFailed: raw.fulltextFailed === true,
    read: raw.read === true,
    starred: raw.starred === true,
    savedPath: asString(raw.savedPath),
  };
}

export function splitKeywords(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

export function matchesFilters(article: Article, feed: Feed): boolean {
  const include = splitKeywords(feed.includeKeywords);
  const exclude = splitKeywords(feed.excludeKeywords);
  const haystack = `${article.title} ${article.summary}`.toLowerCase();
  for (const word of exclude) {
    if (haystack.indexOf(word) >= 0) return false;
  }
  if (include.length === 0) return true;
  for (const word of include) {
    if (haystack.indexOf(word) >= 0) return true;
  }
  return false;
}

export function matchesQuery(article: Article, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${article.title} ${article.author} ${article.summary}`.toLowerCase();
  return haystack.indexOf(needle) >= 0;
}

export interface ArticleRef {
  article: Article;
  feed: Feed;
}

/** What a cache migration did, in the terms the notice reports it in. */
export interface CacheMigrationReport {
  /** Feeds whose cache file was created in the target folder. */
  copied: number;
  /** Feeds whose file already existed there and was merged into. */
  merged: number;
  /** Articles carried across from the sources, before de-duplication. */
  articles: number;
}

/**
 * Fold one cached copy of an article into another. Used only by the folder
 * migration, where the two sides are two snapshots of the same feed taken in
 * different folders: neither may win outright, because each can hold the newer
 * half. `over` is the copy that was already in the target folder, so it keeps
 * the content, while everything a migration must not lose — a read flag, a
 * starred flag, an extracted body — survives from either side.
 */
function combineCachedArticles(base: Article, over: Article): Article {
  const fulltext = over.fulltext || base.fulltext;
  return {
    id: over.id,
    feedId: over.feedId || base.feedId,
    title: over.title || base.title,
    link: over.link || base.link,
    author: over.author || base.author,
    publishedAt: over.publishedAt || base.publishedAt,
    summary: over.summary || base.summary,
    content: over.content || base.content,
    fulltext,
    fulltextFetchedAt: Math.max(over.fulltextFetchedAt, base.fulltextFetchedAt),
    /* A failure only once both sides failed. If either one never tried, the
       flag has to stay off so the next refresh may try again. */
    fulltextFailed: fulltext ? false : over.fulltextFailed && base.fulltextFailed,
    read: over.read || base.read,
    starred: over.starred || base.starred,
    savedPath: over.savedPath || base.savedPath,
  };
}

/** Union of two cached lists, newest first, with the target copy winning. */
function combineCachedLists(
  target: Article[],
  source: Article[],
  maxArticles: number
): Article[] {
  const byId = new Map<string, Article>();
  for (const article of source) byId.set(article.id, article);
  for (const article of target) {
    const previous = byId.get(article.id);
    byId.set(article.id, previous ? combineCachedArticles(previous, article) : article);
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => b.publishedAt - a.publishedAt);
  return merged.slice(0, Math.max(20, maxArticles));
}

function pathSafe(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, "");
}

export class FeedStore {
  feeds: Feed[] = [];

  /**
   * Vault-relative folder the per-feed JSON files live in. Reassigned by
   * `RssSubscribePlugin.applyCacheFolder`, and only ever after the store has
   * been flushed — a pending write belongs to the folder it was read from.
   */
  folder: string;

  private cache = new Map<string, Article[]>();
  private dirty = new Set<string>();
  private app: App;
  private pluginId: string;

  constructor(app: App, pluginId: string, folder: string) {
    this.app = app;
    this.pluginId = pluginId;
    this.folder = folder;
  }

  /**
   * Where 0.7.0 and older kept the caches: inside the plugin folder, which is
   * the location the folder setting now replaces. Offered as a migration
   * source on top of the previous setting, so an upgrade does not silently
   * look like an empty reader.
   */
  get legacyFolder(): string {
    return `${this.app.vault.configDir}/plugins/${this.pluginId}/cache`;
  }

  private cachePath(feedId: string): string {
    return `${this.folder}/${pathSafe(feedId)}.json`;
  }

  private async ensureFolder(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.folder))) {
        await adapter.mkdir(this.folder);
      }
    } catch (error) {
      console.error("RSS Subscribe: could not create the cache folder", error);
    }
  }

  async loadAll(): Promise<void> {
    this.cache.clear();
    await this.ensureFolder();
    for (const feed of this.feeds) {
      this.cache.set(feed.id, await this.readCache(feed.id));
    }
  }

  private async readCache(feedId: string): Promise<Article[]> {
    return this.readCacheFile(this.cachePath(feedId), feedId);
  }

  /** `label` only feeds the error message; `path` is what gets read. */
  private async readCacheFile(path: string, label: string): Promise<Article[]> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return [];
      const raw = await adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Article[] = [];
      for (const entry of parsed) {
        const article = normalizeArticle(entry as Partial<Article>);
        if (article) out.push(article);
      }
      return out;
    } catch (error) {
      console.error(`RSS Subscribe: could not read the cache of ${label}`, error);
      return [];
    }
  }

  articlesFor(feedId: string): Article[] {
    return this.cache.get(feedId) ?? [];
  }

  getArticle(feedId: string, id: string): Article | null {
    const list = this.cache.get(feedId);
    if (!list) return null;
    for (const article of list) {
      if (article.id === id) return article;
    }
    return null;
  }

  findArticle(id: string): ArticleRef | null {
    for (const feed of this.feeds) {
      const article = this.getArticle(feed.id, id);
      if (article) return { article, feed };
    }
    return null;
  }

  listArticles(): ArticleRef[] {
    const out: ArticleRef[] = [];
    for (const feed of this.feeds) {
      for (const article of this.articlesFor(feed.id)) {
        out.push({ article, feed });
      }
    }
    out.sort((a, b) => b.article.publishedAt - a.article.publishedAt);
    return out;
  }

  unreadCount(feedId?: string): number {
    let total = 0;
    for (const feed of this.feeds) {
      if (feedId && feed.id !== feedId) continue;
      for (const article of this.articlesFor(feed.id)) {
        if (!article.read) total += 1;
      }
    }
    return total;
  }

  starredCount(): number {
    let total = 0;
    for (const feed of this.feeds) {
      for (const article of this.articlesFor(feed.id)) {
        if (article.starred) total += 1;
      }
    }
    return total;
  }

  countForFeed(feedId: string): number {
    return this.articlesFor(feedId).length;
  }

  groups(): string[] {
    const out: string[] = [];
    for (const feed of this.feeds) {
      if (feed.group && out.indexOf(feed.group) < 0) out.push(feed.group);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  mergeArticles(feed: Feed, parsed: ParsedFeed, maxArticles: number): number {
    const existing = this.cache.get(feed.id) ?? [];
    const byId = new Map<string, Article>();
    for (const article of existing) byId.set(article.id, article);

    const base = feed.siteUrl || feed.url;
    let added = 0;
    const incoming = parsed.items.slice(0, MAX_ITEMS_PER_FETCH);

    for (const item of incoming) {
      const seed = item.guid || item.link || item.title;
      if (!seed) continue;
      const id = articleId(seed);
      const previous = byId.get(id);
      const safeSummary = cut(safeHtml(item.summary, item.link || base));
      const safeContent = cut(safeHtml(item.content, item.link || base));
      if (previous) {
        if (safeSummary) previous.summary = safeSummary;
        if (safeContent && !previous.fulltext) previous.content = safeContent;
        if (!previous.link && item.link) previous.link = item.link;
        if (!previous.author && item.author) previous.author = item.author;
        if (!previous.publishedAt && item.publishedAt) previous.publishedAt = item.publishedAt;
        continue;
      }
      added += 1;
      byId.set(id, {
        id,
        feedId: feed.id,
        title: item.title || item.link || t("common.untitled"),
        link: item.link,
        author: item.author,
        publishedAt: item.publishedAt || Date.now(),
        summary: safeSummary,
        content: safeContent,
        fulltext: "",
        fulltextFetchedAt: 0,
        fulltextFailed: false,
        read: false,
        starred: false,
        savedPath: "",
      });
    }

    const merged = Array.from(byId.values());
    merged.sort((a, b) => b.publishedAt - a.publishedAt);
    const capped = merged.slice(0, Math.max(20, maxArticles));
    this.cache.set(feed.id, capped);
    this.dirty.add(feed.id);
    return added;
  }

  update(feedId: string, id: string, patch: Partial<Article>): boolean {
    const list = this.cache.get(feedId);
    if (!list) return false;
    for (const article of list) {
      if (article.id !== id) continue;
      Object.assign(article, patch);
      this.dirty.add(feedId);
      return true;
    }
    return false;
  }

  markAllRead(refs: ArticleRef[]): number {
    return this.markAll(refs, true);
  }

  /** The mirror of `markAllRead`: every article in `refs` drops its read flag. */
  markAllUnread(refs: ArticleRef[]): number {
    return this.markAll(refs, false);
  }

  private markAll(refs: ArticleRef[], read: boolean): number {
    let changed = 0;
    for (const ref of refs) {
      if (ref.article.read === read) continue;
      ref.article.read = read;
      this.dirty.add(ref.article.feedId);
      changed += 1;
    }
    return changed;
  }

  async addFeed(feed: Feed): Promise<void> {
    this.feeds.push(feed);
    this.cache.set(feed.id, []);
    await this.ensureFolder();
  }

  async removeFeed(feedId: string): Promise<void> {
    this.feeds = this.feeds.filter((feed) => feed.id !== feedId);
    this.cache.delete(feedId);
    this.dirty.delete(feedId);
    try {
      const adapter = this.app.vault.adapter;
      const path = this.cachePath(feedId);
      if (await adapter.exists(path)) await adapter.remove(path);
    } catch (error) {
      console.error(`RSS Subscribe: could not delete the cache of ${feedId}`, error);
    }
  }

  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const pending = Array.from(this.dirty);
    this.dirty.clear();
    await this.ensureFolder();
    for (const feedId of pending) {
      const list = this.cache.get(feedId) ?? [];
      try {
        await this.app.vault.adapter.write(this.cachePath(feedId), JSON.stringify(list));
      } catch (error) {
        console.error(`RSS Subscribe: could not write the cache of ${feedId}`, error);
      }
    }
  }

  /**
   * Pull the caches of `sources` into the current folder, one feed file at a
   * time, and drop each source file once its content is safely in the target.
   * A feed that exists on both sides is merged rather than overwritten: the
   * target side is usually the fresher one while the source side is often the
   * only place a body was ever saved, so neither may simply win.
   *
   * A source that holds nothing is skipped silently — that is the normal state
   * of the legacy folder once a migration has run. The caller is expected to
   * reload afterwards: nothing here touches the in-memory cache.
   */
  async migrateFrom(sources: string[], maxArticles: number): Promise<CacheMigrationReport> {
    const report: CacheMigrationReport = { copied: 0, merged: 0, articles: 0 };
    const adapter = this.app.vault.adapter;
    const visited = new Set<string>();
    for (const source of sources) {
      if (!source || source === this.folder || visited.has(source)) continue;
      visited.add(source);
      let files: string[];
      try {
        if (!(await adapter.exists(source))) continue;
        files = (await adapter.list(source)).files;
      } catch (error) {
        console.error(`RSS Subscribe: could not list the cache folder ${source}`, error);
        continue;
      }
      for (const file of files) {
        const name = file.slice(file.lastIndexOf("/") + 1);
        if (name.toLowerCase().endsWith(".json")) {
          await this.moveCacheFile(file, name, maxArticles, report);
        }
      }
      try {
        await adapter.rmdir(source, false);
      } catch {
        /* Non-recursive on purpose, and quiet: a folder that still holds
           something (a stray file, a subfolder) is not empty enough to remove,
           and leaving it behind costs nothing. */
      }
    }
    return report;
  }

  private async moveCacheFile(
    sourcePath: string,
    name: string,
    maxArticles: number,
    report: CacheMigrationReport
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const incoming = await this.readCacheFile(sourcePath, sourcePath);
    if (incoming.length === 0) return;

    const targetPath = `${this.folder}/${name}`;
    await this.ensureFolder();
    const existing = await this.readCacheFile(targetPath, targetPath);
    try {
      await adapter.write(
        targetPath,
        JSON.stringify(combineCachedLists(existing, incoming, maxArticles))
      );
    } catch (error) {
      /* Nothing is deleted below, so a failed write leaves the data where it
         was and the button can simply be pressed again. */
      console.error(`RSS Subscribe: could not write the migrated cache of ${name}`, error);
      return;
    }

    if (existing.length > 0) report.merged += 1;
    else report.copied += 1;
    report.articles += incoming.length;

    try {
      await adapter.remove(sourcePath);
    } catch (error) {
      /* Already written to the target folder, so the leftover copy is only
         untidy — not worth failing the whole migration over. */
      console.error(`RSS Subscribe: could not remove the old cache of ${name}`, error);
    }
  }

  markDirty(feedId: string): void {
    this.dirty.add(feedId);
  }
}
