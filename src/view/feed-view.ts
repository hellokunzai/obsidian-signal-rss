import { ItemView, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import type { ArticleRef } from "../core/store";
import { insertSafeHtml } from "../core/sanitize";
import {
  DEFAULT_LIST_WIDTH,
  MAX_LIST_SHARE,
  MIN_LIST_WIDTH,
  MIN_READER_WIDTH,
  VIEW_TYPE_RSS_SUBSCRIBE,
} from "./constants";
import type { NarrowPane } from "./constants";
import { absoluteTime, iconButton, openExternal, textButton } from "./dom";
import { ListPane, renderListToolbar } from "./list-pane";

/**
 * The reader tab. Depending on `settings.listPosition` it shows the list column
 * on the left of the reader, or the reader alone (the list then lives in the
 * right sidebar, see `RssSidebarView`).
 *
 * Filter/selection state is *not* stored here: it belongs to the plugin, so the
 * sidebar copy and this tab always agree on what is selected and filtered.
 */
export class RssSubscribeView extends ItemView {
  private plugin: RssSubscribePlugin;
  private listPane: ListPane;
  private narrowPane: NarrowPane = "list";
  private isNarrow = false;
  private opened = false;
  private pendingFulltext = "";
  private resizeObserver: ResizeObserver | null = null;
  /** Live value while the column handle is being dragged; read back on pointerup. */
  private pendingListWidth = 0;
  /** Selection as of the last render, so a pick from either list can be spotted. */
  private renderedSelectedId = "";

  constructor(leaf: WorkspaceLeaf, plugin: RssSubscribePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.listPane = new ListPane(plugin, {
      // Clicking a filter inside this pane should bring the list back into view
      // when the view is narrow enough to stack the two panes.
      onLocalIntent: () => {
        this.narrowPane = "list";
      },
    });
  }

  getViewType(): string {
    return VIEW_TYPE_RSS_SUBSCRIBE;
  }

  getDisplayText(): string {
    return t("view.title");
  }

  getIcon(): string {
    return "rss";
  }

  async onOpen(): Promise<void> {
    this.opened = true;
    this.refresh();
    this.resizeObserver = new ResizeObserver(() => {
      const narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < 720;
      if (narrow !== this.isNarrow) {
        this.render();
        return;
      }
      // The stored pane sizes are absolute pixels, so a shrunk window can leave
      // them too large. Re-clamp on every resize; writing a var only touches the
      // children, so it cannot retrigger this observer.
      this.applyStoredListWidth();
      this.listPane.reclamp();
    });
    this.resizeObserver.observe(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.listPane.dispose();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  /**
   * Workspace layout persistence. The state itself is plugin-wide, but keeping
   * it on the leaf means Obsidian restores the filter you left behind.
   */
  getState(): Record<string, unknown> {
    return { ...this.plugin.listState };
  }

  async setState(state: unknown, result: unknown): Promise<void> {
    void result;
    if (state && typeof state === "object") {
      this.plugin.restoreListState(state as Record<string, unknown>);
    }
    if (this.opened) this.refresh();
  }

  refresh(): void {
    if (!this.opened) return;
    const selectedId = this.plugin.listState.selectedId;
    const changed = selectedId !== this.renderedSelectedId;
    this.renderedSelectedId = selectedId;
    // A fresh pick — from either copy of the list — wins the narrow split: on a
    // phone the point of clicking an article is to read it.
    if (changed && selectedId && this.isNarrow) this.narrowPane = "reader";
    this.render();
    if (changed && selectedId) void this.maybeFetchFulltext();
  }

  private selectedRef(): ArticleRef | null {
    return this.plugin.selectedRef();
  }

  render(): void {
    const container = this.contentEl;
    const width = container.clientWidth;
    this.isNarrow = width > 0 && width < 720;
    // Read scroll offsets and the search caret before the rebuild wipes them.
    this.listPane.capture(container);
    container.empty();
    container.addClass("rss-subscribe-view");
    container.style.setProperty("--rss-font-size", `${this.plugin.settings.readerFontSize}px`);
    container.style.setProperty("--rss-line-height", String(this.plugin.settings.readerLineHeight));

    const withList = this.plugin.settings.listPosition !== "sidebar";
    const selected = this.selectedRef();
    // Stacked (narrow) mode hides one pane or the other, which only makes sense
    // when there are two panes to choose from.
    const stacked = this.isNarrow && withList;
    const shell = container.createDiv({ cls: stacked ? "rss-shell is-narrow" : "rss-shell" });
    if (stacked && this.narrowPane === "reader" && selected) shell.addClass("is-narrow-reader");

    if (withList) {
      const toolbar = shell.createDiv({ cls: "rss-toolbar" });
      renderListToolbar(this.plugin, toolbar);
    }

    const body = shell.createDiv({ cls: "rss-body" });
    const listPaneEl = withList ? body.createDiv() : null;
    // Appended between the two panes, so it lands exactly on their shared edge.
    if (withList) this.renderColumnResizer(body);
    const readerPane = body.createDiv({ cls: "rss-reader-pane" });

    if (listPaneEl) this.listPane.render(listPaneEl);
    this.renderReader(readerPane, selected);
    this.applyStoredListWidth();
  }

  /* ---------- column drag handle ---------- */

  /**
   * Vertical handle between the list and the reader. Dragging writes a live
   * `--rss-list-width` onto the view container instead of touching the two
   * panes, so a later `render()` (which rebuilds every node) keeps the size.
   */
  private renderColumnResizer(parent: HTMLElement): void {
    const handle = parent.createDiv({ cls: "rss-resizer rss-resizer-col" });
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.tabIndex = 0;
    handle.setAttribute("aria-label", `${t("view.resizer.width")} · ${t("view.resizer.hint")}`);
    if (this.isNarrow) handle.addClass("is-hidden");

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = this.measureListWidth();
      this.capturePointer(handle, event);
      this.beginResize(handle, "x");
      const move = (moveEvent: PointerEvent): void => {
        this.writeListWidth(startWidth + (moveEvent.clientX - startX));
      };
      const stop = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        this.endResize(handle, "x");
        this.commitListWidth();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });

    handle.addEventListener("dblclick", () => {
      this.plugin.settings.listPaneWidth = 0;
      void this.plugin.saveSettings();
      this.plugin.notifyViews();
    });

    handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 40 : 12;
      let next = 0;
      if (event.key === "ArrowLeft") next = this.measureListWidth() - step;
      else if (event.key === "ArrowRight") next = this.measureListWidth() + step;
      else return;
      event.preventDefault();
      this.writeListWidth(next);
      this.commitListWidth();
    });
  }

  /**
   * Capture keeps `pointermove` coming to the handle even once the pointer
   * leaves its 5px strip. It can throw for a pointer that is already gone, and
   * in that case plain listeners on the handle are still a usable fallback.
   */
  private capturePointer(handle: HTMLElement, event: PointerEvent): void {
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer already released: the drag still works while over the handle. */
    }
  }

  private beginResize(handle: HTMLElement, axis: "x" | "y"): void {
    handle.addClass("is-dragging");
    this.contentEl.addClass("rss-resizing");
    this.contentEl.addClass(axis === "x" ? "rss-resizing-x" : "rss-resizing-y");
  }

  private endResize(handle: HTMLElement, axis: "x" | "y"): void {
    handle.removeClass("is-dragging");
    this.contentEl.removeClass("rss-resizing");
    this.contentEl.removeClass(axis === "x" ? "rss-resizing-x" : "rss-resizing-y");
  }

  /**
   * Re-apply the stored list width. Called after every render and on window
   * resize, because the value is absolute pixels and must be re-clamped to
   * whatever room the view has right now.
   */
  private applyStoredListWidth(): void {
    // Narrow mode stacks the panes and the sidebar position leaves this view
    // without a column at all, so a stored width means nothing in either case.
    const hasList = this.plugin.settings.listPosition !== "sidebar";
    const stored = this.isNarrow || !hasList ? 0 : this.plugin.settings.listPaneWidth;
    if (stored <= 0) {
      this.contentEl.style.removeProperty("--rss-list-width");
      return;
    }
    this.contentEl.style.setProperty("--rss-list-width", `${this.clampListWidth(stored)}px`);
  }

  private measureListWidth(): number {
    const pane = this.contentEl.querySelector<HTMLElement>(".rss-list-pane");
    if (pane && pane.offsetWidth > 0) return pane.offsetWidth;
    return this.plugin.settings.listPaneWidth || DEFAULT_LIST_WIDTH;
  }

  private clampListWidth(value: number): number {
    const total = this.contentEl.clientWidth;
    const max = Math.max(
      MIN_LIST_WIDTH,
      Math.min(total - MIN_READER_WIDTH, total * MAX_LIST_SHARE)
    );
    return Math.round(Math.max(MIN_LIST_WIDTH, Math.min(value, max)));
  }

  private writeListWidth(value: number): void {
    this.pendingListWidth = this.clampListWidth(value);
    this.contentEl.style.setProperty("--rss-list-width", `${this.pendingListWidth}px`);
  }

  private commitListWidth(): void {
    const width = this.pendingListWidth;
    if (width <= 0 || width === this.plugin.settings.listPaneWidth) return;
    this.plugin.settings.listPaneWidth = width;
    void this.plugin.saveSettings();
  }

  /* ---------- reader ---------- */

  private async maybeFetchFulltext(): Promise<void> {
    const ref = this.selectedRef();
    if (!ref) return;
    const { article, feed } = ref;
    if (!this.plugin.settings.fetchFulltextOnOpen) return;
    if (article.fulltext || article.fulltextFailed) return;
    if (!article.link) return;
    this.pendingFulltext = article.id;
    this.updateReaderStatus(t("view.status.fulltextLoading"));
    const html = await this.plugin.fetchFulltextFor(article, feed);
    this.pendingFulltext = "";
    if (!html) {
      this.updateReaderStatus(t("view.status.fulltextFailed"));
    }
    this.render();
  }

  private updateReaderStatus(text: string): void {
    const body = this.contentEl.querySelector(".rss-reader-body");
    if (!body) return;
    const status = body.createDiv({ cls: "rss-reader-status", text });
    status.addClass("is-pending");
  }

  private renderReader(pane: HTMLElement, ref: ArticleRef | null): void {
    pane.empty();
    if (!ref) {
      const empty = pane.createDiv({ cls: "rss-empty" });
      empty.createDiv({ cls: "rss-empty-title", text: t("view.empty.reader") });
      empty.createDiv({ cls: "rss-empty-hint", text: t("view.empty.readerHint") });
      return;
    }

    const { article, feed } = ref;
    const header = pane.createDiv({ cls: "rss-reader-header" });

    const back = iconButton(header, "arrow-left", t("view.toolbar.back"), () => {
      this.narrowPane = "list";
      this.render();
    });
    back.addClass("rss-back-button");

    const titleRow = header.createDiv({ cls: "rss-reader-titlerow" });
    titleRow.createEl("h2", { cls: "rss-reader-title", text: article.title || article.link });

    const actions = header.createDiv({ cls: "rss-reader-actions" });
    iconButton(actions, article.starred ? "star-off" : "star", article.starred ? t("view.action.unstar") : t("view.action.star"), () => {
      this.plugin.store.update(feed.id, article.id, { starred: !article.starred });
      this.plugin.store.markDirty(feed.id);
      void this.plugin.persistCache();
      this.plugin.notifyViews();
      this.plugin.updateRibbonBadge();
    });
    iconButton(actions, article.read ? "mail" : "mail-open", article.read ? t("view.action.markUnread") : t("view.action.markRead"), () => {
      this.plugin.store.update(feed.id, article.id, { read: !article.read });
      this.plugin.store.markDirty(feed.id);
      void this.plugin.persistCache();
      this.plugin.notifyViews();
      this.plugin.updateRibbonBadge();
    });
    iconButton(actions, "download", t("view.action.fetchFulltext"), () => {
      void this.forceFulltext(ref);
    });
    iconButton(actions, "external-link", t("view.action.openExternal"), () => {
      openExternal(article.link);
    });
    textButton(actions, t("view.action.save"), "cta", () => {
      void this.plugin.saveArticle(ref);
    });

    const meta = header.createDiv({ cls: "rss-reader-meta" });
    meta.createSpan({ text: feed.title || feed.url });
    if (article.author) {
      meta.createSpan({ cls: "rss-dot-sep", text: "·" });
      meta.createSpan({ text: t("view.meta.author", { author: article.author }) });
    }
    if (article.publishedAt) {
      meta.createSpan({ cls: "rss-dot-sep", text: "·" });
      meta.createSpan({ text: absoluteTime(article.publishedAt) });
    }
    if (article.savedPath) {
      meta.createSpan({ cls: "rss-dot-sep", text: "·" });
      meta.createSpan({ cls: "rss-saved-hint", text: t("view.meta.saved", { path: article.savedPath }) });
    }

    const body = pane.createDiv({ cls: "rss-reader-body" });
    if (this.pendingFulltext === article.id) {
      body.createDiv({
        cls: "rss-reader-status is-pending",
        text: t("view.status.fulltextLoading"),
      });
    }
    const html = article.fulltext || article.content || article.summary;
    if (!html) {
      body.createDiv({ cls: "rss-reader-status", text: t("view.status.noContent") });
      return;
    }
    const content = body.createDiv({ cls: "rss-content" });
    insertSafeHtml(content, html);
    this.decorateContent(content);

    const hidden = this.plugin.hiddenByFilters();
    if (hidden > 0) {
      pane.createDiv({
        cls: "rss-reader-footnote",
        text: t("view.status.filtered", { count: String(hidden) }),
      });
    }
  }

  private decorateContent(content: HTMLElement): void {
    const links = content.querySelectorAll("a");
    for (let i = 0; i < links.length; i++) {
      links[i].addClass("external-link");
      links[i].setAttribute("target", "_blank");
      links[i].setAttribute("rel", "noopener noreferrer");
    }
    const images = content.querySelectorAll("img");
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", "no-referrer");
      image.addEventListener("error", () => {
        image.addClass("is-broken");
        const alt = image.getAttribute("alt");
        if (alt) image.setAttribute("title", alt);
      });
    }
  }

  private async forceFulltext(ref: ArticleRef): Promise<void> {
    const { article, feed } = ref;
    if (!article.link) {
      new Notice(t("notice.nothingToFetch"));
      return;
    }
    this.pendingFulltext = article.id;
    this.render();
    const html = await this.plugin.fetchFulltextFor(article, feed, true);
    this.pendingFulltext = "";
    if (!html) new Notice(t("view.status.fulltextFailed"));
    this.render();
  }
}
