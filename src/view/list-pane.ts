import { Notice, Platform, setIcon } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import type { Feed } from "../types";
import {
  DEFAULT_FEED_HEIGHT,
  MAX_FEED_SHARE,
  MIN_ARTICLE_HEIGHT,
  MIN_FEED_HEIGHT,
  UNGROUPED_KEY,
} from "./constants";
import type { FilterKind } from "./constants";
import { iconButton, relativeTime, textButton } from "./dom";

/** How long a finger must rest on a feed row before its menu opens. */
const LONG_PRESS_MS = 500;

/** Movement past this many pixels means the user is scrolling, not pressing. */
const LONG_PRESS_SLOP = 8;

export interface ListToolbarOptions {
  /**
   * The show/hide switch for the list column. Only the reader tab passes this:
   * the sidebar copy *is* the list, so there is nothing there to fold away.
   */
  listToggle?: {
    hidden: boolean;
    onToggle: () => void;
  };
}

/**
 * The toolbar that belongs to the subscription list. It lives here rather than
 * in the view because the list can be hosted either by the reader tab or by the
 * right sidebar, and both hosts have to offer the same actions.
 */
export function renderListToolbar(
  plugin: RssSubscribePlugin,
  toolbar: HTMLElement,
  options: ListToolbarOptions = {}
): void {
  const toggle = options.listToggle;
  if (toggle) {
    // Rendered first, and the toolbar is left-aligned, so the switch lands at
    // the head of the row with the action cluster right behind it: one glance
    // covers "what the list is doing" plus "what I can do to it".
    const group = toolbar.createDiv({ cls: "rss-toolbar-view" });
    // Keep both t() calls literal — the i18n key checker only sees literals.
    const label = toggle.hidden ? t("view.toolbar.showList") : t("view.toolbar.hideList");
    const button = iconButton(
      group,
      toggle.hidden ? "panel-left-open" : "panel-left-close",
      label,
      () => toggle.onToggle()
    );
    button.addClass("rss-list-toggle");
    // The icon names the action, `aria-pressed` names the current mode.
    button.setAttribute("aria-pressed", toggle.hidden ? "true" : "false");
    group.createDiv({ cls: "rss-toolbar-divider" });
  }

  const actions = toolbar.createDiv({ cls: "rss-toolbar-actions" });
  iconButton(actions, "check-check", t("view.toolbar.markAllRead"), () => {
    const refs = plugin.visibleRefs();
    const changed = plugin.store.markAllRead(refs);
    if (changed > 0) {
      void plugin.persistCache();
      new Notice(t("notice.markedAllRead", { count: String(changed) }));
    }
    plugin.notifyViews();
    plugin.updateRibbonBadge();
  });
  iconButton(actions, "refresh-cw", t("view.toolbar.refreshAll"), () => {
    void plugin.refreshAll(false);
  });
  iconButton(actions, "plus", t("view.toolbar.addFeed"), () => {
    plugin.openAddFeedModal(null);
  });
  iconButton(actions, "upload", t("view.toolbar.import"), () => {
    void plugin.importOpmlFromFile();
  });
  iconButton(actions, "download", t("view.toolbar.export"), () => {
    void plugin.exportOpml();
  });
  iconButton(actions, "settings", t("view.toolbar.settings"), () => {
    plugin.openSettings();
  });
}

export interface ListPaneOptions {
  /**
   * True for the copy that fills a sidebar panel: it stretches to the panel
   * height instead of holding the fixed width a column of the reader needs.
   */
  docked?: boolean;
  /**
   * Fired when a click lands inside this pane. The reader view uses it to keep
   * its narrow (stacked) layout in sync with whichever copy was used.
   */
  onLocalIntent?: () => void;
}

/**
 * The search box, the subscription tree, the row drag handle and the article
 * list — everything left of the reader. Both hosts (the reader tab and the
 * right sidebar) mount the exact same component so the two can never drift.
 *
 * All filter/selection state lives on the plugin (`plugin.listState`) and is
 * written through it, so clicking a row in one copy updates the other.
 */
export class ListPane {
  private plugin: RssSubscribePlugin;
  private options: ListPaneOptions;
  private feedScroll = 0;
  private listScroll = 0;
  private searchHadFocus = false;
  private searchCaret: number | null = null;
  private searchTimer: number | null = null;
  /** Live value while the row handle is being dragged; read back on pointerup. */
  private pendingFeedHeight = 0;
  /** Pending long-press on a feed row; cancelled when the press becomes a scroll. */
  private longPressTimer: number | null = null;
  /** Set once a long press fires, so the click trailing it does not also filter. */
  private longPressed = false;
  /** The element this pane was last built into, so we can re-clamp on resize. */
  private hostEl: HTMLElement | null = null;

  constructor(plugin: RssSubscribePlugin, options: ListPaneOptions = {}) {
    this.plugin = plugin;
    this.options = options;
  }

  /**
   * Read scroll offsets and the caret off the live DOM. Must run *before* the
   * host empties itself: re-rendering drops every scroll position and steals
   * focus, which is very visible while typing in the search box.
   */
  capture(root: HTMLElement): void {
    const list = root.querySelector(".rss-article-list");
    this.listScroll = list ? list.scrollTop : 0;
    const feeds = root.querySelector(".rss-feed-section");
    this.feedScroll = feeds ? feeds.scrollTop : 0;
    const search = root.querySelector<HTMLInputElement>(".rss-search");
    this.searchHadFocus = !!search && document.activeElement === search;
    this.searchCaret = search && search.selectionStart !== null ? search.selectionStart : null;
  }

  dispose(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.clearLongPress();
  }

  /** Drop a pending long press. Its timeout outlives the row it was armed on. */
  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  /** Re-apply the stored feed height after the host itself changed size. */
  reclamp(): void {
    if (this.hostEl) this.applyStoredFeedHeight(this.hostEl);
  }

  /** Build the column into `host`, which the caller has just created empty. */
  render(host: HTMLElement): void {
    // The rows are about to be replaced, so any press armed on the old DOM dies here.
    this.clearLongPress();
    this.hostEl = host;
    host.addClass("rss-list-pane");
    if (this.options.docked) host.addClass("rss-list-pane-docked");

    this.renderSearch(host);
    this.renderFeedList(host);
    if (this.feedScroll > 0) {
      const section = host.querySelector(".rss-feed-section");
      if (section) section.scrollTop = this.feedScroll;
    }
    // Sits on the boundary the feed section used to draw with its own border.
    this.renderRowResizer(host);
    this.renderArticleList(host);
    this.applyStoredFeedHeight(host);

    if (this.searchHadFocus) {
      const next = host.querySelector<HTMLInputElement>(".rss-search");
      if (next) {
        next.focus({ preventScroll: true });
        if (this.searchCaret !== null) {
          const position = Math.min(this.searchCaret, next.value.length);
          next.setSelectionRange(position, position);
        }
      }
    }
  }

  /* ---------- search ---------- */

  private renderSearch(pane: HTMLElement): void {
    const bar = pane.createDiv({ cls: "rss-search-bar" });
    const search = bar.createEl("input", {
      cls: "rss-search",
      type: "search",
      placeholder: t("view.search.placeholder"),
    });
    search.value = this.plugin.listState.query;
    search.setAttribute("aria-label", t("view.search.placeholder"));
    search.addEventListener("input", () => {
      // Store the value right away, but only re-render once typing pauses —
      // a rebuild per keystroke would fight the caret.
      this.plugin.listState.query = search.value;
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        this.plugin.notifyViews();
      }, 150);
    });
  }

  /* ---------- feed tree ---------- */

  private renderFeedList(pane: HTMLElement): void {
    const store = this.plugin.store;
    const section = pane.createDiv({ cls: "rss-feed-section" });
    section.createDiv({ cls: "rss-section-label", text: t("view.section.feeds") });

    const all = store.listArticles().length;
    const unread = store.unreadCount();
    const starred = store.starredCount();

    this.filterRow(section, "all", "", t("view.filter.all"), String(all));
    this.filterRow(section, "unread", "", t("view.filter.unread"), String(unread));
    this.filterRow(section, "starred", "", t("view.filter.starred"), String(starred));

    if (store.feeds.length === 0) {
      const empty = section.createDiv({ cls: "rss-empty rss-empty-small" });
      empty.createDiv({ cls: "rss-empty-title", text: t("view.empty.feeds") });
      empty.createDiv({ cls: "rss-empty-hint", text: t("view.empty.feedsHint") });
      const actions = empty.createDiv({ cls: "rss-empty-actions" });
      textButton(actions, t("view.toolbar.addFeed"), "cta", () => {
        this.plugin.openAddFeedModal(null);
      });
      return;
    }

    const groups = store.groups();
    const ungrouped = store.feeds.filter((feed) => !feed.group);
    for (const group of groups) {
      this.groupSection(
        section,
        group,
        group,
        store.feeds.filter((item) => item.group === group)
      );
    }
    if (ungrouped.length > 0) {
      if (groups.length === 0) {
        // No named groups at all: there is nothing to fold, keep the flat list.
        for (const feed of ungrouped) this.feedRow(section, feed);
      } else {
        this.groupSection(section, UNGROUPED_KEY, t("view.uncategorized"), ungrouped);
      }
    }
  }

  /**
   * A collapsible group header plus the feed rows it owns. The header is a real
   * `<button>` so it stays keyboard reachable and gets a focus ring; its rows
   * live in a wrapper div, so folding is a single `hidden` flip.
   */
  private groupSection(parent: HTMLElement, key: string, name: string, feeds: Feed[]): void {
    const collapsed = this.plugin.isGroupCollapsed(key);
    const toggle = parent.createEl("button", {
      cls: collapsed ? "rss-group-toggle is-collapsed" : "rss-group-toggle",
    });
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    // Keep both t() calls literal — the i18n key checker only sees literals.
    toggle.setAttribute(
      "aria-label",
      collapsed
        ? `${name} · ${t("view.group.collapsed")}`
        : `${name} · ${t("view.group.expanded")}`
    );
    const chevron = toggle.createSpan({ cls: "rss-group-chevron" });
    setIcon(chevron, "chevron-down");
    toggle.createSpan({ cls: "rss-group-name", text: name });
    if (collapsed) {
      const unread = feeds.reduce(
        (sum, feed) => sum + this.plugin.store.unreadCount(feed.id),
        0
      );
      if (unread > 0) toggle.createSpan({ cls: "rss-group-count", text: String(unread) });
    }
    toggle.addEventListener("click", () => {
      // Folding is persisted state, so the plugin fans the re-render out to
      // every copy of the list.
      this.plugin.toggleGroupCollapsed(key);
    });

    const body = parent.createDiv({ cls: "rss-group-body" });
    if (collapsed) body.hidden = true;
    for (const feed of feeds) this.feedRow(body, feed);
  }

  private filterRow(
    parent: HTMLElement,
    kind: FilterKind,
    feedId: string,
    label: string,
    count: string
  ): void {
    const state = this.plugin.listState;
    const active = state.filterKind === kind && (kind !== "feed" || state.filterFeedId === feedId);
    const row = parent.createEl("button", {
      cls: active ? "rss-row is-active" : "rss-row",
    });
    row.createSpan({ cls: "rss-row-label", text: label });
    if (count) row.createSpan({ cls: "rss-row-count", text: count });
    row.addEventListener("click", () => {
      this.options.onLocalIntent?.();
      this.plugin.setListState({ filterKind: kind, filterFeedId: feedId });
    });
  }

  private feedRow(parent: HTMLElement, feed: Feed): void {
    const state = this.plugin.listState;
    const active = state.filterKind === "feed" && state.filterFeedId === feed.id;
    const row = parent.createEl("button", {
      cls: active ? "rss-row rss-row-feed is-active" : "rss-row rss-row-feed",
    });
    const dot = row.createSpan({ cls: "rss-feed-dot" });
    if (feed.lastError) dot.addClass("is-error");
    row.createSpan({ cls: "rss-row-label", text: feed.title || feed.url });
    const unread = this.plugin.store.unreadCount(feed.id);
    if (unread > 0) row.createSpan({ cls: "rss-row-count", text: String(unread) });
    row.setAttribute(
      "aria-label",
      `${feed.title || feed.url} · ${t("view.meta.count", { count: String(unread) })}`
    );
    row.addEventListener("click", () => {
      // A long press already opened the menu; the click trailing it is not a
      // filter change and would otherwise dismiss what the menu was opened for.
      if (this.longPressed) {
        this.longPressed = false;
        return;
      }
      this.options.onLocalIntent?.();
      this.plugin.setListState({ filterKind: "feed", filterFeedId: feed.id });
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // Some mobile WebViews do deliver this event on a long press. Whichever
      // of the two arrives first wins; the other is dropped here.
      this.longPressed = false;
      this.clearLongPress();
      this.plugin.openFeedMenu(feed, { x: event.clientX, y: event.clientY });
    });

    this.attachLongPress(row, feed);
  }

  /**
   * Mobile has no right-click, and its WebView does not reliably turn a long
   * press into a `contextmenu` event, so the feed menu is armed on a timer
   * instead. `touch-action` is deliberately left alone: the list still has to
   * scroll, and a press that travels past the slop is cancelled below.
   */
  private attachLongPress(row: HTMLElement, feed: Feed): void {
    if (!Platform.isMobile) return;

    let originX = 0;
    let originY = 0;
    const cancel = (): void => this.clearLongPress();

    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      originX = event.clientX;
      originY = event.clientY;
      this.longPressed = false;
      this.clearLongPress();
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = null;
        this.longPressed = true;
        this.plugin.openFeedMenu(feed, { x: originX, y: originY });
      }, LONG_PRESS_MS);
    });

    row.addEventListener("pointermove", (event) => {
      if (this.longPressTimer === null) return;
      const drift = Math.max(
        Math.abs(event.clientX - originX),
        Math.abs(event.clientY - originY)
      );
      if (drift > LONG_PRESS_SLOP) cancel();
    });

    row.addEventListener("pointerup", cancel);
    row.addEventListener("pointercancel", cancel);
  }

  /* ---------- articles ---------- */

  private renderArticleList(pane: HTMLElement): void {
    const state = this.plugin.listState;
    const refs = this.plugin.visibleRefs();
    const section = pane.createDiv({ cls: "rss-article-section" });
    const header = section.createDiv({ cls: "rss-section-label" });
    header.createSpan({ text: t("view.section.articles") });
    if (refs.length > 0) {
      const unread = refs.filter((ref) => !ref.article.read).length;
      header.createSpan({
        cls: "rss-section-count",
        text:
          unread > 0
            ? t("view.section.articlesCount", {
                count: String(refs.length),
                unread: String(unread),
              })
            : String(refs.length),
      });
    }

    // Filtering by a single feed makes the source name on every row pure noise.
    const hideSource = state.filterKind === "feed" && !!state.filterFeedId;

    const list = section.createDiv({ cls: "rss-article-list" });
    if (refs.length === 0) {
      const empty = list.createDiv({ cls: "rss-empty rss-empty-small" });
      empty.createDiv({ cls: "rss-empty-title", text: t("view.empty.articles") });
      empty.createDiv({ cls: "rss-empty-hint", text: t("view.empty.articlesHint") });
      return;
    }

    for (const ref of refs) {
      const { article, feed } = ref;
      const active = article.id === state.selectedId;
      const row = list.createEl("button", {
        cls: active ? "rss-article-row is-active" : "rss-article-row",
      });
      if (!article.read) row.addClass("is-unread");

      row.createSpan({ cls: "rss-unread-dot" });

      const body = row.createSpan({ cls: "rss-article-body" });
      body.createSpan({ cls: "rss-article-title", text: article.title || article.link });

      const meta = body.createSpan({ cls: "rss-article-meta" });
      if (!hideSource) {
        meta.createSpan({ cls: "rss-article-source", text: feed.title || feed.url });
        meta.createSpan({ cls: "rss-dot-sep", text: "·" });
      }
      meta.createSpan({ cls: "rss-article-time", text: relativeTime(article.publishedAt) });

      if (article.starred) {
        const star = row.createSpan({ cls: "rss-article-star" });
        setIcon(star, "star");
      }

      row.addEventListener("click", () => {
        this.plugin.selectArticle(ref);
      });
    }

    if (this.listScroll > 0) {
      list.scrollTop = this.listScroll;
    }
  }

  /* ---------- row drag handle ---------- */

  /**
   * Horizontal handle between the feed section and the article list. It writes
   * `--rss-feed-height` onto the pane instead of a fixed height, so a later
   * rebuild (which replaces every node) keeps the size.
   */
  private renderRowResizer(pane: HTMLElement): void {
    const handle = pane.createDiv({ cls: "rss-resizer rss-resizer-row" });
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.tabIndex = 0;
    handle.setAttribute("aria-label", `${t("view.resizer.height")} · ${t("view.resizer.hint")}`);

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const startY = event.clientY;
      const startHeight = this.measureFeedHeight(pane);
      this.capturePointer(handle, event);
      this.beginResize(handle, pane, "y");
      const move = (moveEvent: PointerEvent): void => {
        this.writeFeedHeight(pane, startHeight + (moveEvent.clientY - startY));
      };
      const stop = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        this.endResize(handle, pane, "y");
        this.commitFeedHeight();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });

    handle.addEventListener("dblclick", () => {
      this.resetFeedHeight();
    });

    handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 40 : 12;
      let next = 0;
      if (event.key === "ArrowUp") next = this.measureFeedHeight(pane) - step;
      else if (event.key === "ArrowDown") next = this.measureFeedHeight(pane) + step;
      else return;
      event.preventDefault();
      this.writeFeedHeight(pane, next);
      this.commitFeedHeight();
    });
  }

  /**
   * Capture keeps `pointermove` coming to the handle even once the pointer
   * leaves its 7px strip. It can throw for a pointer that is already gone, and
   * in that case plain listeners on the handle are still a usable fallback.
   */
  private capturePointer(handle: HTMLElement, event: PointerEvent): void {
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer already released: the drag still works while over the handle. */
    }
  }

  private beginResize(handle: HTMLElement, pane: HTMLElement, axis: "x" | "y"): void {
    handle.addClass("is-dragging");
    const root = this.viewRoot(pane);
    root.addClass("rss-resizing");
    root.addClass(axis === "x" ? "rss-resizing-x" : "rss-resizing-y");
  }

  private endResize(handle: HTMLElement, pane: HTMLElement, axis: "x" | "y"): void {
    handle.removeClass("is-dragging");
    const root = this.viewRoot(pane);
    root.removeClass("rss-resizing");
    root.removeClass(axis === "x" ? "rss-resizing-x" : "rss-resizing-y");
  }

  private viewRoot(pane: HTMLElement): HTMLElement {
    const root = pane.closest(".rss-subscribe-view");
    return root instanceof HTMLElement ? root : pane;
  }

  /** Back to the stylesheet default (45% of the list pane). */
  private resetFeedHeight(): void {
    this.plugin.settings.feedPaneHeight = 0;
    void this.plugin.saveSettings();
    this.plugin.notifyViews();
  }

  /**
   * Re-apply the stored height. Called after every render and on window resize,
   * because the value is absolute pixels and must be re-clamped to whatever
   * room this particular copy of the pane has right now — the reader tab and
   * the sidebar are different heights.
   */
  private applyStoredFeedHeight(pane: HTMLElement): void {
    const stored = this.plugin.settings.feedPaneHeight;
    if (stored <= 0) {
      pane.style.removeProperty("--rss-feed-height");
      return;
    }
    pane.style.setProperty("--rss-feed-height", `${this.clampFeedHeight(pane, stored)}px`);
  }

  private measureFeedHeight(pane: HTMLElement): number {
    const section = pane.querySelector<HTMLElement>(".rss-feed-section");
    return section ? section.offsetHeight : DEFAULT_FEED_HEIGHT;
  }

  private clampFeedHeight(pane: HTMLElement, value: number): number {
    const paneHeight = pane.offsetHeight || pane.clientHeight;
    const search = pane.querySelector<HTMLElement>(".rss-search-bar");
    const searchHeight = search ? search.offsetHeight : 46;
    // The handle and the article section's top padding also need room.
    const available = paneHeight - searchHeight - 20;
    const max = Math.max(
      MIN_FEED_HEIGHT,
      Math.min(available - MIN_ARTICLE_HEIGHT, available * MAX_FEED_SHARE)
    );
    return Math.round(Math.max(MIN_FEED_HEIGHT, Math.min(value, max)));
  }

  private writeFeedHeight(pane: HTMLElement, value: number): void {
    this.pendingFeedHeight = this.clampFeedHeight(pane, value);
    pane.style.setProperty("--rss-feed-height", `${this.pendingFeedHeight}px`);
  }

  private commitFeedHeight(): void {
    const height = this.pendingFeedHeight;
    if (height <= 0 || height === this.plugin.settings.feedPaneHeight) return;
    this.plugin.settings.feedPaneHeight = height;
    void this.plugin.saveSettings();
  }
}
