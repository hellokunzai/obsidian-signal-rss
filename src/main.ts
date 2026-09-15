import { Menu, Notice, Platform, Plugin } from "obsidian";
import { t } from "./i18n";
import {
  DEFAULT_SETTINGS,
  LIST_POSITIONS,
  SETTINGS_VERSION,
} from "./types";
import type {
  AddFeedResult,
  Article,
  DiscoverResult,
  Feed,
  RssSubscribeSettings,
} from "./types";
import { FeedStore, newFeedId } from "./core/store";
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
 * in a view because the list can be on screen twice at once — inside the reader
 * tab and in the right sidebar — and both copies must agree.
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

    this.store = new FeedStore(this.app, this.manifest.id);
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

    this.ribbonIconEl = this.addRibbonIcon("rss", t("ribbon.tooltip"), () => {
      void this.activateView();
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
    // Hand back a fresh array: Object.assign would otherwise alias
    // DEFAULT_SETTINGS.collapsedGroups, and a later toggle would mutate the module default.
    this.settings.collapsedGroups = Array.isArray(this.settings.collapsedGroups)
      ? this.settings.collapsedGroups.filter((key) => typeof key === "string")
      : [];
    // Pane sizes come from a drag handle, so a corrupted store could hold
    // anything. Clamp on the way in and let the view re-clamp on every render.
    this.settings.listPaneWidth = sanitizePaneSize(this.settings.listPaneWidth);
    this.settings.feedPaneHeight = sanitizePaneSize(this.settings.feedPaneHeight);
    // "In both places" is no longer offered — keeping two copies of the list in
    // sync was the whole cost of that mode and none of its value. Anyone still
    // holding it keeps the sidebar copy: that is the pane their saved workspace
    // layout restores, and the reader tab then drops its duplicate on its own.
    if ((this.settings.listPosition as string) === "both") {
      this.settings.listPosition = "sidebar";
    }
    // A hand-edited data.json could hold anything, and the value drives which
    // panes get built. Fall back to the default rather than to a broken layout.
    if (!LIST_POSITIONS.includes(this.settings.listPosition)) {
      this.settings.listPosition = DEFAULT_SETTINGS.listPosition;
    }
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
   * Every foldable group key: the named groups plus "" for the ungrouped bucket.
   * Drives the collapse-all command and decides whether it applies at all.
   */
  groupKeys(): string[] {
    if (!this.store) return [];
    const keys = this.store.groups();
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
    this.settings = { ...DEFAULT_SETTINGS };
    await this.persist();
    this.applyScheduler();
    this.notifyViews();
    new Notice(t("settings.reset.done"));
  }

  async persistCache(): Promise<void> {
    await this.store.flush();
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
   * Picking an article is the one action both copies of the list can start, so
   * it lives here: mark it read once, then let every view re-render.
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
    // The list can be the sidebar's only occupant, and then nothing on screen
    // renders the reader at all: the pick would land in the shared state with
    // nobody to show it, which reads as "clicking a row does nothing". The
    // article has to end up on screen, so bring the reader tab forward.
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
   * Bring the right sidebar copy of the list up (creating it once).
   * `reveal` is opt-in because on mobile the sidebar is a full-screen drawer:
   * folding the list into it should not yank it open over what you are reading.
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
   * Reconcile the right sidebar with the saved setting. Called when the setting
   * changes; never on load, because the workspace may still be restoring its
   * own layout at that point and we would create a duplicate panel.
   */
  async applyListPosition(): Promise<void> {
    if (this.settings.listPosition === "main") {
      this.closeListSidebar();
      this.notifyViews();
      return;
    }
    await this.openListSidebar(!Platform.isMobile);
    if (Platform.isMobile) new Notice(t("notice.listMovedToSidebar"));
  }

  /**
   * The command palette entry. It is a *visibility* switch, not a
   * create/destroy switch: a panel that is merely folded away has to open
   * again, otherwise pressing the command would delete the list instead of
   * showing it — which is the normal state on mobile, where folding it into
   * the drawer never expanded it in the first place.
   *
   * Showing it hands the list to the sidebar, hiding it hands the list back to
   * the reader tab. `listPosition` follows both ways, so it always names where
   * the list actually is — and there is only ever one copy of it.
   */
  async toggleListSidebar(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RSS_SIDEBAR);
    const right = this.app.workspace.rightSplit;

    if (leaves.length > 0 && right && right.collapsed) {
      right.expand();
      if (this.settings.listPosition !== "sidebar") {
        this.settings.listPosition = "sidebar";
        await this.saveSettings();
      }
      this.notifyViews();
      return;
    }

    if (leaves.length > 0) {
      this.closeListSidebar();
      // Closing has to leave the list somewhere, and the setting has to stay
      // truthful, so the list falls back to the reader view.
      if (this.settings.listPosition !== "main") {
        this.settings.listPosition = "main";
        await this.saveSettings();
      }
      this.notifyViews();
      return;
    }
    // Opening it moves the list out of the reader view and into the sidebar.
    this.settings.listPosition = "sidebar";
    await this.saveSettings();
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
   */
  openGroupMenu(
    groupValue: string,
    displayName: string,
    feeds: Feed[],
    position: { x: number; y: number }
  ): void {
    const menu = new Menu();
    // A disabled label item rather than a section title: it names the scope the
    // entries below it act on, which is the one thing the menu cannot say
    // otherwise once it is detached from the header it was opened on.
    menu.addItem((item) =>
      item
        .setTitle(t("view.group.scope", { name: displayName, count: String(feeds.length) }))
        .setIsLabel(true)
    );
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
