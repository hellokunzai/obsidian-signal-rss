import { Menu, Notice, Platform, Plugin } from "obsidian";
import { t } from "./i18n";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
} from "./types";
import type {
  AddFeedResult,
  Article,
  CacheMigrationResult,
  DiscoverResult,
  Feed,
  RssSubscribeSettings,
} from "./types";
import { FeedStore, cacheFolderPath, newFeedId } from "./core/store";
import type { ArticleRef } from "./core/store";
import { matchesFilters, matchesQuery } from "./core/store";
import { networkHint } from "./core/net-error";
import {
  DEFAULT_TIMEOUT_MS,
  discoverFeed,
  fetchFeed,
  fetchText,
  normalizeUrl,
} from "./core/fetcher";
import { extractArticleHtml } from "./core/fulltext";
import { buildOpml, parseOpml } from "./core/opml";
import { htmlToPlainText } from "./core/sanitize";
import { saveArticleAsNote } from "./note/saver";
import { RssSubscribeSettingTab } from "./settings";
import { AddFeedModal } from "./ui/add-feed-modal";
import { GroupNameModal } from "./ui/group-name-modal";
import { RssSubscribeView } from "./view/feed-view";
import { RssSidebarView } from "./view/sidebar-view";
import { UNGROUPED_KEY, VIEW_TYPE_RSS_SIDEBAR, VIEW_TYPE_RSS_SUBSCRIBE } from "./view/constants";

const EXPORT_BASENAME = "rss-subscribe-subscriptions";
const REFRESH_CONCURRENCY = 3;

interface PersistedData {
  settings?: Partial<RssSubscribeSettings>;
  feeds?: Partial<Feed>[];
}

/**
 * Everything the list column shows: which filter is picked, what is typed in
 * the search box and which article is open. It lives on the plugin rather than
 * in the sidebar view because the reader tab depends on it too — the sidebar
 * picks an article, the reader renders it — and because the workspace layout
 * restores it through `RssSubscribeView.getState`.
 */
export interface ListState {
  filterKind: "all" | "unread" | "starred" | "feed";
  filterFeedId: string;
  query: string;
  selectedId: string;
}

function defaultListState(): ListState {
  return { filterKind: "all", filterFeedId: "", query: "", selectedId: "" };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A stored pane size is either a sane round pixel count, or 0 for "use the default". */
function sanitizePaneSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * Swap one group key for another inside a settings list keyed by group name
 * (the declared group list, and the folded-group list). An empty `to` means
 * "drop this key". The ungrouped bucket's own key *is* "", so the drop is keyed
 * off the match rather than off the resulting value — otherwise folding the
 * ungrouped bucket away would be mistaken for a deletion.
 *
 * Always hands back a fresh array: these lists are read straight off the
 * settings object, which must never be mutated in place.
 */
function retargetGroupKey(list: string[], from: string, to: string): string[] {
  const next: string[] = [];
  for (const key of list) {
    if (key === from && !to) continue;
    const value = key === from ? to : key;
    if (next.indexOf(value) < 0) next.push(value);
  }
  return next;
}

function normalizeFeed(raw: Partial<Feed> | null | undefined): Feed | null {
  if (!raw || typeof raw !== "object") return null;
  const url = asText(raw.url);
  if (!url) return null;
  return {
    id: asText(raw.id) || newFeedId(url),
    title: asText(raw.title) || url,
    url,
    siteUrl: asText(raw.siteUrl),
    group: asText(raw.group),
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
    lastFetchedAt: typeof raw.lastFetchedAt === "number" ? raw.lastFetchedAt : 0,
    lastError: asText(raw.lastError),
    includeKeywords: asText(raw.includeKeywords),
    excludeKeywords: asText(raw.excludeKeywords),
  };
}

export default class RssSubscribePlugin extends Plugin {
  settings: RssSubscribeSettings = { ...DEFAULT_SETTINGS };
  store!: FeedStore;
  /** Shared by every copy of the list column; see `ListState`. */
  listState: ListState = defaultListState();

  private storedFeeds: Feed[] = [];
  private ribbonIconEl: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private refreshing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.store = new FeedStore(
      this.app,
      this.manifest.id,
      cacheFolderPath(this.settings.cacheFolder)
    );
    this.store.feeds = this.storedFeeds;
    await this.store.loadAll();

    this.registerView(
      VIEW_TYPE_RSS_SUBSCRIBE,
      (leaf) => new RssSubscribeView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_RSS_SIDEBAR,
      (leaf) => new RssSidebarView(leaf, this)
    );

    // The ribbon is the way in, and what it brings up is the subscription list,
    // not the reader: the reader tab is opened later, by picking an article
    // (see `selectArticle`). Opening it from here instead would drop the user
    // on an empty pane with nothing to click and the list nowhere in sight.
    this.ribbonIconEl = this.addRibbonIcon("rss", t("ribbon.tooltip"), () => {
      void this.openListSidebar(true);
    });
    this.updateRibbonBadge();

    this.registerCommands();
    this.addSettingTab(new RssSubscribeSettingTab(this.app, this));
    this.applyScheduler();
  }

  onunload(): void {
    void this.store.flush();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-reader",
      name: t("command.openView"),
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "toggle-sidebar-list",
      name: t("command.toggleSidebar"),
      callback: () => {
        void this.toggleListSidebar();
      },
    });

    this.addCommand({
      id: "refresh-all",
      name: t("command.refreshAll"),
      callback: () => {
        void this.refreshAll(false);
      },
    });

    this.addCommand({
      id: "add-feed",
      name: t("command.addFeed"),
      callback: () => {
        this.openAddFeedModal(null);
      },
    });

    this.addCommand({
      id: "import-opml",
      name: t("command.importOpml"),
      callback: () => {
        void this.importOpmlFromFile();
      },
    });

    this.addCommand({
      id: "export-opml",
      name: t("command.exportOpml"),
      callback: () => {
        void this.exportOpml();
      },
    });

    this.addCommand({
      id: "mark-all-read",
      name: t("command.markAllRead"),
      callback: () => {
        const refs = this.store.listArticles();
        const changed = this.store.markAllRead(refs);
        void this.persistCache();
        this.updateRibbonBadge();
        this.notifyViews();
        new Notice(t("notice.markedAllRead", { count: String(changed) }));
      },
    });

    this.addCommand({
      id: "collapse-all-groups",
      name: t("command.collapseGroups"),
      checkCallback: (checking) => {
        const keys = this.groupKeys();
        if (keys.length === 0) return false;
        // Everything already folded: nothing left to do, so hide the command.
        if (keys.every((key) => this.isGroupCollapsed(key))) return false;
        if (!checking) void this.setAllGroupsCollapsed(true);
        return true;
      },
    });

    this.addCommand({
      id: "expand-all-groups",
      name: t("command.expandGroups"),
      checkCallback: (checking) => {
        if (this.settings.collapsedGroups.length === 0) return false;
        if (!checking) void this.setAllGroupsCollapsed(false);
        return true;
      },
    });

    this.addCommand({
      id: "save-current-article",
      name: t("command.saveArticle"),
      checkCallback: (checking) => {
        const ref = this.currentRef();
        if (!ref) return false;
        if (!checking) void this.saveArticle(ref);
        return true;
      },
    });
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PersistedData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.settings.version = SETTINGS_VERSION;
    // Hand back fresh arrays: Object.assign would otherwise alias the
    // DEFAULT_SETTINGS lists, and a later toggle would mutate the module default.
    this.settings.groups = Array.isArray(this.settings.groups)
      ? this.settings.groups.filter((name) => typeof name === "string" && name.length > 0)
      : [];
    this.settings.collapsedGroups = Array.isArray(this.settings.collapsedGroups)
      ? this.settings.collapsedGroups.filter((key) => typeof key === "string")
      : [];
    // Pane sizes come from a drag handle, so a corrupted store could hold
    // anything. Clamp on the way in and let the view re-clamp on every render.
    this.settings.feedPaneHeight = sanitizePaneSize(this.settings.feedPaneHeight);
    // Hand-typed and hand-editable, so it is normalised in both directions: a
    // data.json holding `null` or `../../notes` must not decide where the
    // caches go.
    this.settings.cacheFolder = cacheFolderPath(this.settings.cacheFolder);
    this.settings.cacheFolderPrevious = asText(this.settings.cacheFolderPrevious);
    const feeds: Feed[] = [];
    if (data && Array.isArray(data.feeds)) {
      for (const raw of data.feeds) {
        const feed = normalizeFeed(raw);
        if (feed) feeds.push(feed);
      }
    }
    this.storedFeeds = feeds;
  }

  private async persist(): Promise<void> {
    const data: PersistedData = {
      settings: this.settings,
      feeds: this.store ? this.store.feeds : this.storedFeeds,
    };
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  async saveFeeds(): Promise<void> {
    await this.persist();
  }

  /**
   * Every group the tree draws, in the order it draws them. Two sources make up
   * one list: the names the feeds carry (`Store.groups()`), and the names the
   * user declared by hand. A group with feeds in it is already covered by the
   * first, but an empty one has nothing to be derived from — it exists only
   * because someone asked for it, so it is stored in the settings instead.
   */
  groupNames(): string[] {
    if (!this.store) return [];
    const names: string[] = [];
    for (const name of [...this.store.groups(), ...this.settings.groups]) {
      if (name && !names.includes(name)) names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b));
    return names;
  }

  /**
   * Every foldable group key: the named groups plus "" for the ungrouped bucket.
   * Drives the collapse-all command and decides whether it applies at all.
   */
  groupKeys(): string[] {
    if (!this.store) return [];
    const keys = this.groupNames();
    return this.store.feeds.some((feed) => !feed.group) ? [...keys, UNGROUPED_KEY] : keys;
  }

  isGroupCollapsed(key: string): boolean {
    return this.settings.collapsedGroups.includes(key);
  }

  /**
   * Deliberately synchronous and self-notifying: the change is persisted in the
   * background and every copy of the list re-renders right away.
   */
  toggleGroupCollapsed(key: string): void {
    const next = new Set(this.settings.collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.settings.collapsedGroups = [...next];
    this.saveSettings().catch((error) =>
      console.error("RSS Subscribe: could not persist folded groups", error)
    );
    this.notifyViews();
  }

  async setAllGroupsCollapsed(collapsed: boolean): Promise<void> {
    this.settings.collapsedGroups = collapsed ? this.groupKeys() : [];
    await this.saveSettings();
    this.notifyViews();
  }

  async resetSettings(): Promise<void> {
    /* Flush first and re-point the store afterwards: resetting the folder
       without moving the store would leave the pending articles addressed to
       a folder the settings no longer name. */
    await this.store.flush();
    const previous = this.store.folder;
    this.settings = { ...DEFAULT_SETTINGS, cacheFolderPrevious: previous };
    await this.persist();
    this.store.folder = cacheFolderPath(DEFAULT_SETTINGS.cacheFolder);
    await this.store.loadAll();
    this.applyScheduler();
    this.notifyViews();
    this.updateRibbonBadge();
    new Notice(t("settings.reset.done"));
  }

  async persistCache(): Promise<void> {
    await this.store.flush();
  }

  /**
   * Point the store at whatever `settings.cacheFolder` currently holds, if that
   * is not where it already is. Returns whether anything moved, so the settings
   * row knows whether a notice is worth showing.
   *
   * The order matters: pending writes are flushed to the folder they were read
   * from *before* the switch, and the folder that is being left behind is
   * remembered so the migration button can still reach it.
   */
  async applyCacheFolder(): Promise<boolean> {
    const next = cacheFolderPath(this.settings.cacheFolder);
    /* The typed value can differ from the path it normalises to (a trailing
       slash, a leading one). Writing it back keeps the field honest about
       where the caches actually are. */
    const retargeted = next !== this.settings.cacheFolder;
    this.settings.cacheFolder = next;
    if (next === this.store.folder) {
      if (retargeted) await this.saveSettings();
      return false;
    }

    await this.store.flush();
    this.settings.cacheFolderPrevious = this.store.folder;
    await this.saveSettings();
    this.store.folder = next;
    await this.store.loadAll();
    this.notifyViews();
    this.updateRibbonBadge();
    new Notice(t("notice.cacheFolderChanged", { path: next }));
    return true;
  }

  /**
   * Move the caches of every folder the store has used before into the current
   * one. Nothing happens on its own: pointing the setting somewhere else leaves
   * the old files where they are, and this is the deliberate second step.
   */
  async migrateCache(): Promise<CacheMigrationResult> {
    try {
      /* The field may hold a folder that has not been applied yet — the settings
         row debounces that — so settle it first, or the files would be moved
         into the folder the store is about to leave. */
      await this.applyCacheFolder();
      await this.store.flush();
      const report = await this.store.migrateFrom(
        [this.settings.cacheFolderPrevious, this.store.legacyFolder],
        this.settings.maxArticlesPerFeed
      );
      if (report.copied + report.merged > 0) {
        await this.store.loadAll();
        this.notifyViews();
        this.updateRibbonBadge();
      }
      return { ok: true, feeds: report.copied + report.merged, articles: report.articles };
    } catch (error) {
      console.error("RSS Subscribe: could not migrate the cache", error);
      return { ok: false, message: describeError(error) };
    }
  }

  applyScheduler(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    const minutes = this.settings.refreshIntervalMinutes;
    if (!minutes || minutes <= 0) return;
    const milliseconds = Math.max(1, minutes) * 60 * 1000;
    this.refreshTimer = this.registerInterval(
      window.setInterval(() => {
        void this.refreshAll(true);
      }, milliseconds)
    );
  }

  /**
   * Open the reader in the main area and bring it to the front. With no reader
   * leaf around, `getLeaf("tab")` hands back the empty tab that is already
   * open rather than stacking a second one next to it — which is also where
   * `showReader` lands when an article is picked and no reader is open.
   *
   * Reached from the "open reader" command and from `showReader`; the ribbon
   * icon opens the list sidebar instead.
   */
  async activateView(): Promise<void> {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_RSS_SUBSCRIBE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_RSS_SUBSCRIBE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  notifyViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SUBSCRIBE)) {
      const view = leaf.view;
      if (view instanceof RssSubscribeView) view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR)) {
      const view = leaf.view;
      if (view instanceof RssSidebarView) view.refresh();
    }
  }

  /* ---------- shared list state ---------- */

  /** Articles the current filter and search query let through, newest first. */
  visibleRefs(): ArticleRef[] {
    const state = this.listState;
    const out: ArticleRef[] = [];
    for (const feed of this.store.feeds) {
      if (state.filterKind === "feed" && state.filterFeedId && feed.id !== state.filterFeedId) {
        continue;
      }
      for (const article of this.store.articlesFor(feed.id)) {
        if (state.filterKind === "unread" && article.read) continue;
        if (state.filterKind === "starred" && !article.starred) continue;
        if (!matchesFilters(article, feed)) continue;
        if (!matchesQuery(article, state.query)) continue;
        out.push({ article, feed });
      }
    }
    out.sort((a, b) => b.article.publishedAt - a.article.publishedAt);
    return out;
  }

  /** How many articles the feed-level filter rules are hiding right now. */
  hiddenByFilters(): number {
    let hidden = 0;
    for (const feed of this.store.feeds) {
      for (const article of this.store.articlesFor(feed.id)) {
        if (!matchesFilters(article, feed)) hidden += 1;
      }
    }
    return hidden;
  }

  selectedRef(): ArticleRef | null {
    if (!this.listState.selectedId) return null;
    return this.store.findArticle(this.listState.selectedId);
  }

  setListState(patch: Partial<ListState>): void {
    Object.assign(this.listState, patch);
    this.notifyViews();
  }

  /** Rehydrate from a restored workspace layout (see `RssSubscribeView.getState`). */
  restoreListState(raw: Record<string, unknown>): void {
    const kind = raw.filterKind;
    if (kind === "all" || kind === "unread" || kind === "starred" || kind === "feed") {
      this.listState.filterKind = kind;
    }
    if (typeof raw.filterFeedId === "string") this.listState.filterFeedId = raw.filterFeedId;
    if (typeof raw.query === "string") this.listState.query = raw.query;
    if (typeof raw.selectedId === "string") this.listState.selectedId = raw.selectedId;
  }

  /**
   * Picking an article is the one action the list can start and the reader has
   * to hear about, so it lives here: mark it read once, then let every view
   * re-render.
   */
  selectArticle(ref: ArticleRef): void {
    this.listState.selectedId = ref.article.id;
    if (this.settings.markReadOnOpen && !ref.article.read) {
      this.store.update(ref.feed.id, ref.article.id, { read: true });
      void this.persistCache();
    }
    this.updateRibbonBadge();
    this.notifyViews();
    // On mobile the docked copy of the list is a drawer that covers the reader,
    // and picking an article is exactly the moment you want to see the article.
    if (Platform.isMobile && this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR).length > 0) {
      this.app.workspace.rightSplit.collapse();
    }
    // The list lives in the sidebar and the reader in a main-area tab, so when
    // nothing has been picked yet there is no view on screen that renders the
    // reader at all: the pick would land in the shared state with nobody to
    // show it, which reads as "clicking a row does nothing". This is the
    // normal way the reader tab comes into being, so the article has to end up
    // on screen — bring the reader tab forward, opening it if need be.
    void this.showReader();
  }

  /**
   * Put the reader in front of the user, opening its tab when there is none.
   *
   * Returns early when it is already the tab being looked at: revealing a leaf
   * also moves keyboard focus, and doing that on every pick would pull the
   * caret out of the sidebar's search box while the reader sits right there
   * updating itself.
   */
  private async showReader(): Promise<void> {
    const workspace = this.app.workspace;
    const leaf = workspace.getLeavesOfType(VIEW_TYPE_RSS_SUBSCRIBE)[0];
    // Ask `rootSplit` specifically. While the user works in a sidebar leaf the
    // workspace's own active leaf is the list, so it cannot answer "is the
    // reader on screen?" — this can.
    if (leaf && workspace.getMostRecentLeaf(workspace.rootSplit) === leaf) return;
    await this.activateView();
  }

  /* ---------- list placement ---------- */

  /**
   * Bring the subscription list up in the right sidebar (creating it once).
   * This is what the ribbon icon calls, and what the reader's empty state falls
   * back to when the list is not on screen.
   *
   * `reveal` is opt-in because on mobile the sidebar is a full-screen drawer:
   * folding the list into it should not yank it open over what you are reading.
   * An explicit click on the ribbon is the opposite case — there the drawer
   * *is* the thing being asked for.
   */
  async openListSidebar(reveal = true): Promise<void> {
    // `ensureSideLeaf` looks for an existing leaf of this type before creating
    // one, so whatever else the user keeps in the sidebar is left alone.
    await this.app.workspace.ensureSideLeaf(VIEW_TYPE_RSS_SIDEBAR, "right", {
      active: false,
      reveal,
    });
    this.notifyViews();
  }

  private closeListSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR)) {
      leaf.detach();
    }
  }

  /**
   * True while the subscription list is actually on screen in the sidebar. A
   * leaf that exists inside a folded split does not count — the list is equally
   * out of reach either way, and the reader's empty state keys off this to
   * decide whether it has to offer a way into the list.
   */
  isListSidebarVisible(): boolean {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR).length === 0) return false;
    const right = this.app.workspace.rightSplit;
    return !right || !right.collapsed;
  }

  /**
   * Toggle the subscription list in the right sidebar. It is a visibility
   * switch: if the sidebar is folded, expand it; if the list panel exists, close
   * it; otherwise create it.
   */
  async toggleListSidebar(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR);
    const right = this.app.workspace.rightSplit;

    if (leaves.length > 0 && right && right.collapsed) {
      right.expand();
      this.notifyViews();
      return;
    }

    if (leaves.length > 0) {
      this.closeListSidebar();
      // The reader's empty state falls back to a button that reopens the list,
      // so the view has to be told the list just went away.
      this.notifyViews();
      return;
    }

    await this.openListSidebar(true);
  }

  updateRibbonBadge(): void {
    if (!this.ribbonIconEl) return;
    const unread = this.store ? this.store.unreadCount() : 0;
    const label =
      unread > 0
        ? `${t("ribbon.tooltip")} · ${t("view.meta.count", { count: String(unread) })}`
        : t("ribbon.tooltip");
    this.ribbonIconEl.setAttribute("aria-label", label);
  }

  private currentRef(): ArticleRef | null {
    return this.selectedRef();
  }

  /**
   * `presetGroup` pre-fills the group field when a feed is added from a group's
   * own menu, so "add to this group" costs no retyping. It is left empty for the
   * ungrouped bucket: its key is "" and its label is not a real group name.
   */
  openAddFeedModal(feed: Feed | null, presetGroup = ""): void {
    new AddFeedModal(this.app, this, feed, presetGroup).open();
  }

  /** Every article under a set of feeds, for the bulk actions a group menu runs. */
  private articlesOf(feeds: Feed[]): ArticleRef[] {
    const out: ArticleRef[] = [];
    for (const feed of feeds) {
      for (const article of this.store.articlesFor(feed.id)) out.push({ article, feed });
    }
    return out;
  }

  /* ---------- groups ---------- */

  /**
   * The menu behind the empty space under the subscription tree. Creating a
   * group belongs to no row — there is no row about it yet — so it hangs off
   * the background of the section that draws the tree.
   */
  openTreeMenu(position: { x: number; y: number }): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("view.tree.newGroup"))
        .setIcon("folder-plus")
        .onClick(() => {
          this.promptNewGroup();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.tree.addFeed"))
        .setIcon("plus")
        .onClick(() => {
          this.openAddFeedModal(null);
        })
    );
    menu.showAtPosition(position);
  }

  promptNewGroup(): void {
    new GroupNameModal(this.app, {
      title: t("modal.groupName.titleCreate"),
      value: "",
      submitLabel: t("modal.groupName.create"),
      onSubmit: (name) => this.createGroup(name),
    }).open();
  }

  promptRenameGroup(name: string): void {
    new GroupNameModal(this.app, {
      title: t("modal.groupName.titleRename"),
      value: name,
      submitLabel: t("modal.groupName.save"),
      onSubmit: (next) => this.renameGroup(name, next),
    }).open();
  }

  /**
   * Declare a group with no feeds in it yet. Nothing is written when the name is
   * blank or already taken, and `false` goes back to the dialog so it can stay
   * open and say so rather than closing on a name that went nowhere.
   */
  createGroup(rawName: string): boolean {
    const name = rawName.trim();
    if (!name) {
      new Notice(t("notice.groupNeedsName"));
      return false;
    }
    if (this.groupNames().includes(name)) {
      new Notice(t("notice.groupExists", { name }));
      return false;
    }
    this.settings.groups = [...this.settings.groups, name];
    void this.saveSettings();
    this.notifyViews();
    new Notice(t("notice.groupCreated", { name }));
    return true;
  }

  /**
   * Rename a group: its feeds move with it, and so do the two settings lists
   * keyed by the old name — a folded group that kept the old key would spring
   * open, and a declared group would be left behind as an empty duplicate.
   */
  renameGroup(from: string, rawTo: string): boolean {
    const to = rawTo.trim();
    if (!to) {
      new Notice(t("notice.groupNeedsName"));
      return false;
    }
    if (to === from) return true;
    if (this.groupNames().includes(to)) {
      new Notice(t("notice.groupExists", { name: to }));
      return false;
    }
    for (const feed of this.store.feeds) {
      if (feed.group === from) feed.group = to;
    }
    this.settings.groups = retargetGroupKey(this.settings.groups, from, to);
    this.settings.collapsedGroups = retargetGroupKey(this.settings.collapsedGroups, from, to);
    void this.persist();
    this.notifyViews();
    new Notice(t("notice.groupRenamed", { name: to }));
    return true;
  }

  /**
   * Delete a group. The feeds inside it are not deleted — they drop back to the
   * ungrouped bucket, which is exactly where they were before anyone named the
   * group, so nothing is lost and there is nothing to confirm first.
   */
  deleteGroup(name: string): void {
    let moved = 0;
    for (const feed of this.store.feeds) {
      if (feed.group !== name) continue;
      feed.group = "";
      moved += 1;
    }
    this.settings.groups = retargetGroupKey(this.settings.groups, name, "");
    this.settings.collapsedGroups = retargetGroupKey(this.settings.collapsedGroups, name, "");
    void this.persist();
    this.notifyViews();
    // Keep both t() calls literal — the i18n key checker only sees literals.
    new Notice(
      moved > 0
        ? t("notice.groupDeleted", { name, count: String(moved) })
        : t("notice.groupDeletedEmpty", { name })
    );
  }

  /** Bulk read/unread across a set of feeds, reported like the other batch jobs. */
  private markFeeds(feeds: Feed[], read: boolean): void {
    const refs = this.articlesOf(feeds);
    const changed = read ? this.store.markAllRead(refs) : this.store.markAllUnread(refs);
    if (changed > 0) {
      void this.persistCache();
      // Keep both t() calls literal — the i18n key checker only sees literals.
      new Notice(
        read
          ? t("notice.markedAllRead", { count: String(changed) })
          : t("notice.markedAllUnread", { count: String(changed) })
      );
    }
    this.notifyViews();
    this.updateRibbonBadge();
  }

  /**
   * The menu behind a group header. Everything on it is scoped to that group
   * except the OPML pair: which file to import, and where an export lands, are
   * decisions a group has no say in.
   *
   * Takes a position rather than a mouse event for the same reason the feed
   * menu does — the desktop opens it from a right-click, the mobile long press
   * from a touch, and `showAtMouseEvent` has nothing to read off a touch.
   *
   * No scope label at the top. The menu opens on the group header it belongs
   * to, so a line naming that group only repeats what the click already said —
   * the count it used to carry is on the header row as well.
   *
   * Rename and delete sit at the bottom, behind their own separator: they act on
   * the group itself rather than on what is inside it, and they are not the
   * reason anyone opens this menu.
   */
  openGroupMenu(
    groupValue: string,
    feeds: Feed[],
    position: { x: number; y: number }
  ): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.refresh"))
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.refreshFeeds(feeds, false);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.addFeed"))
        .setIcon("plus")
        .onClick(() => {
          this.openAddFeedModal(null, groupValue);
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.importOpml"))
        .setIcon("upload")
        .onClick(() => {
          void this.importOpmlFromFile();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.exportOpml"))
        .setIcon("download")
        .onClick(() => {
          void this.exportOpml();
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.markAllRead"))
        .setIcon("check-check")
        .onClick(() => {
          this.markFeeds(feeds, true);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.markAllUnread"))
        .setIcon("mail")
        .onClick(() => {
          this.markFeeds(feeds, false);
        })
    );
    // The ungrouped bucket is not a group anyone named — it is where feeds land
    // when they have no group — so there is nothing there to rename or delete.
    if (groupValue !== UNGROUPED_KEY) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(t("view.group.rename"))
          .setIcon("pencil")
          .onClick(() => {
            this.promptRenameGroup(groupValue);
          })
      );
      menu.addItem((item) =>
        item
          .setTitle(t("view.group.delete"))
          .setIcon("trash-2")
          .onClick(() => {
            this.deleteGroup(groupValue);
          })
      );
    }
    menu.showAtPosition(position);
  }

  /**
   * Takes a position rather than a mouse event: the desktop opens this from a
   * right-click, the mobile long-press from a touch, and `showAtMouseEvent`
   * has nothing to read off a touch.
   */
  openFeedMenu(feed: Feed, position: { x: number; y: number }): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("view.action.refreshFeed"))
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.refreshFeed(feed, false);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.action.markRead"))
        .setIcon("check-check")
        .onClick(() => {
          const refs = this.store
            .articlesFor(feed.id)
            .map((article) => ({ article, feed }));
          const changed = this.store.markAllRead(refs);
          void this.persistCache().then(() => {
            this.notifyViews();
            this.updateRibbonBadge();
          });
          new Notice(t("notice.markedAllRead", { count: String(changed) }));
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.action.editFeed"))
        .setIcon("pencil")
        .onClick(() => {
          this.openAddFeedModal(feed);
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("view.action.deleteFeed"))
        .setIcon("trash-2")
        .onClick(() => {
          void this.removeFeed(feed);
        })
    );
    menu.showAtPosition(position);
  }

  /** Per-request timeout in ms, derived from the settings slider. */
  private get requestTimeoutMs(): number {
    const seconds = this.settings.requestTimeoutSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.round(seconds * 1000);
  }

  async discoverInput(value: string): Promise<DiscoverResult> {
    try {
      const found = await discoverFeed(value, this.requestTimeoutMs);
      return { ok: true, url: found.url, title: found.feed.title };
    } catch (error) {
      console.error("RSS Subscribe: feed discovery failed", error);
      return { ok: false, message: describeError(error), hint: networkHint(error) };
    }
  }

  async addFeedFromInput(rawUrl: string, title: string, group: string): Promise<AddFeedResult> {
    let normalized = "";
    try {
      normalized = normalizeUrl(rawUrl);
    } catch {
      return { ok: false, message: t("notice.invalidUrl"), hint: "" };
    }
    if (this.store.feeds.some((feed) => feed.url === normalized)) {
      return { ok: false, message: t("notice.alreadySubscribed"), hint: "" };
    }
    try {
      const found = await discoverFeed(normalized, this.requestTimeoutMs);
      if (this.store.feeds.some((feed) => feed.url === found.url)) {
        return { ok: false, message: t("notice.alreadySubscribed"), hint: "" };
      }
      const feed: Feed = {
        id: newFeedId(found.url),
        title: title || found.feed.title || found.url,
        url: found.url,
        siteUrl: found.feed.siteUrl,
        group,
        addedAt: Date.now(),
        lastFetchedAt: Date.now(),
        lastError: "",
        includeKeywords: "",
        excludeKeywords: "",
      };
      await this.store.addFeed(feed);
      this.store.mergeArticles(feed, found.feed, this.settings.maxArticlesPerFeed);
      await this.store.flush();
      await this.saveFeeds();
      new Notice(t("notice.feedAdded", { title: feed.title }));
      this.notifyViews();
      this.updateRibbonBadge();
      return { ok: true, feed };
    } catch (error) {
      return { ok: false, message: describeError(error), hint: networkHint(error) };
    }
  }

  async editFeed(
    feed: Feed,
    patch: { url: string; title: string; group: string }
  ): Promise<void> {
    try {
      feed.url = normalizeUrl(patch.url);
    } catch {
      new Notice(t("notice.invalidUrl"));
      return;
    }
    if (patch.title) feed.title = patch.title;
    feed.group = patch.group;
    feed.lastError = "";
    await this.saveFeeds();
    new Notice(t("notice.feedUpdated", { title: feed.title }));
    await this.refreshFeed(feed, false);
    this.notifyViews();
  }

  async removeFeed(feed: Feed): Promise<void> {
    await this.store.removeFeed(feed.id);
    await this.saveFeeds();
    new Notice(t("notice.feedDeleted", { title: feed.title || feed.url }));
    this.notifyViews();
    this.updateRibbonBadge();
  }

  async refreshAll(silent: boolean): Promise<void> {
    await this.refreshFeeds(this.store.feeds.slice(), silent);
  }

  /**
   * Refresh an explicit set of feeds. Split out of `refreshAll` so the group
   * menu can refresh the group the user pointed at instead of dragging every
   * subscription into the round: same machinery, narrower scope.
   */
  async refreshFeeds(feeds: Feed[], silent: boolean): Promise<void> {
    if (this.refreshing) return;
    if (feeds.length === 0) {
      if (!silent) new Notice(t("notice.noFeeds"));
      return;
    }
    this.refreshing = true;
    if (!silent) new Notice(t("notice.refreshing", { count: String(feeds.length) }));

    let added = 0;
    let failed = 0;
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(REFRESH_CONCURRENCY, feeds.length);
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(
        (async () => {
          while (cursor < feeds.length) {
            const feed = feeds[cursor];
            cursor += 1;
            try {
              added += await this.refreshFeedInternal(feed);
            } catch (error) {
              failed += 1;
              feed.lastError = describeError(error);
            }
          }
        })()
      );
    }
    await Promise.all(workers);
    await this.store.flush();
    await this.saveFeeds();
    this.notifyViews();
    this.updateRibbonBadge();
    this.refreshing = false;

    if (failed > 0) new Notice(t("notice.refreshFailed", { count: String(failed) }));
    if (!silent || added > 0) {
      new Notice(t("notice.refreshDone", { added: String(added) }));
    }
  }

  async refreshFeed(feed: Feed, silent: boolean): Promise<void> {
    try {
      const added = await this.refreshFeedInternal(feed);
      await this.store.flush();
      await this.saveFeeds();
      this.notifyViews();
      this.updateRibbonBadge();
      if (!silent) new Notice(t("notice.refreshDone", { added: String(added) }));
    } catch (error) {
      feed.lastError = describeError(error);
      await this.saveFeeds();
      this.notifyViews();
      new Notice(
        t("notice.refreshFeedFailed", {
          title: feed.title || feed.url,
          message: describeError(error),
        })
      );
    }
  }

  private async refreshFeedInternal(feed: Feed): Promise<number> {
    const parsed = await fetchFeed(feed.url, this.requestTimeoutMs);
    if (!feed.title || feed.title === feed.url) {
      feed.title = parsed.title || feed.url;
    }
    if (!feed.siteUrl) feed.siteUrl = parsed.siteUrl;
    const added = this.store.mergeArticles(feed, parsed, this.settings.maxArticlesPerFeed);
    feed.lastFetchedAt = Date.now();
    feed.lastError = "";
    this.store.markDirty(feed.id);
    if (this.settings.fetchFulltextOnRefresh && added > 0) {
      await this.fetchFulltextBatch(feed);
    }
    return added;
  }

  private async fetchFulltextBatch(feed: Feed): Promise<void> {
    const recent = this.store.articlesFor(feed.id).slice(0, 20);
    for (const article of recent) {
      if (!article.link || article.fulltext || article.fulltextFailed) continue;
      const length = htmlToPlainText(article.content || article.summary).length;
      if (length > 1200) continue;
      await this.fetchFulltextFor(article, feed);
    }
  }

  async fetchFulltextFor(article: Article, feed: Feed, force = false): Promise<string> {
    if (!article.link) return "";
    if (!force && article.fulltext) return article.fulltext;
    try {
      const page = await fetchText(article.link, this.requestTimeoutMs);
      const extracted = extractArticleHtml(page, article.link);
      if (!extracted) {
        this.store.update(feed.id, article.id, { fulltextFailed: true });
        await this.store.flush();
        return "";
      }
      this.store.update(feed.id, article.id, {
        fulltext: extracted,
        fulltextFetchedAt: Date.now(),
        fulltextFailed: false,
      });
      await this.store.flush();
      return extracted;
    } catch (error) {
      console.error("RSS Subscribe: full text extraction failed", error);
      this.store.update(feed.id, article.id, { fulltextFailed: true });
      await this.store.flush();
      return "";
    }
  }

  async saveArticle(ref: ArticleRef): Promise<void> {
    const { article, feed } = ref;
    const html = article.fulltext || article.content || article.summary;
    try {
      const result = await saveArticleAsNote(this.app, article, feed, this.settings, html);
      this.store.update(feed.id, article.id, { savedPath: result.path, read: true });
      await this.store.flush();
      new Notice(t("notice.articleSaved", { path: result.path }));
      if (this.settings.openAfterSave) {
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(result.file);
      }
      this.notifyViews();
      this.updateRibbonBadge();
    } catch (error) {
      new Notice(t("notice.saveFailed", { message: describeError(error) }));
    }
  }

  async importOpmlFromFile(): Promise<void> {
    const input = document.body.createEl("input", { cls: "rss-subscribe-file-input" });
    input.type = "file";
    input.accept = ".opml,.xml,text/xml,application/xml";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          void this.importOpmlText(result);
        } else {
          new Notice(t("notice.opmlImportFailed", { message: t("error.fileRead") }));
        }
      };
      reader.onerror = () => {
        new Notice(t("notice.opmlImportFailed", { message: t("error.fileRead") }));
      };
      reader.readAsText(file);
    });
    input.click();
  }

  async importOpmlText(xml: string): Promise<void> {
    try {
      const entries = parseOpml(xml);
      let added = 0;
      for (const entry of entries) {
        if (this.store.feeds.some((feed) => feed.url === entry.xmlUrl)) continue;
        const feed: Feed = {
          id: newFeedId(entry.xmlUrl),
          title: entry.title || entry.xmlUrl,
          url: entry.xmlUrl,
          siteUrl: entry.htmlUrl,
          group: entry.group,
          addedAt: Date.now(),
          lastFetchedAt: 0,
          lastError: "",
          includeKeywords: "",
          excludeKeywords: "",
        };
        await this.store.addFeed(feed);
        added += 1;
      }
      await this.saveFeeds();
      new Notice(t("notice.opmlImported", { count: String(added) }));
      this.notifyViews();
      if (added > 0) void this.refreshAll(true);
    } catch (error) {
      new Notice(t("notice.opmlImportFailed", { message: describeError(error) }));
    }
  }

  async exportOpml(): Promise<void> {
    try {
      const xml = buildOpml(this.store.feeds, t("view.title"));
      const path = this.uniqueVaultPath(EXPORT_BASENAME, "opml");
      await this.app.vault.create(path, xml);
      new Notice(t("notice.opmlExported", { path }));
    } catch (error) {
      new Notice(t("notice.opmlExportFailed", { message: describeError(error) }));
    }
  }

  private uniqueVaultPath(basename: string, extension: string): string {
    let candidate = `${basename}.${extension}`;
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${basename} ${index}.${extension}`;
      index += 1;
    }
    return candidate;
  }
}
