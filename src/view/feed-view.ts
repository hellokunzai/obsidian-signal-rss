import { ItemView, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import type { ArticleRef } from "../core/store";
import { insertSafeHtml } from "../core/sanitize";
import { VIEW_TYPE_RSS_SUBSCRIBE } from "./constants";
import { absoluteTime, iconButton, openExternal, textButton } from "./dom";

/**
 * The reader tab. The subscription list lives in the right sidebar; this view
 * only renders the selected article.
 *
 * Filter/selection state is *not* stored here: it belongs to the plugin, so this
 * tab always renders whatever the sidebar list last picked.
 */
export class RssSubscribeView extends ItemView {
  private plugin: RssSubscribePlugin;
  private opened = false;
  private pendingFulltext = "";
  /** Selection as of the last render, so a pick from the sidebar can be spotted. */
  private renderedSelectedId = "";

  constructor(leaf: WorkspaceLeaf, plugin: RssSubscribePlugin) {
    super(leaf);
    this.plugin = plugin;
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
  }

  async onClose(): Promise<void> {
    this.opened = false;
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
    this.render();
    if (changed && selectedId) void this.maybeFetchFulltext();
  }

  private selectedRef(): ArticleRef | null {
    return this.plugin.selectedRef();
  }

  render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("rss-subscribe-view");
    container.style.setProperty("--rss-font-size", `${this.plugin.settings.readerFontSize}px`);
    container.style.setProperty("--rss-line-height", String(this.plugin.settings.readerLineHeight));

    const shell = container.createDiv({ cls: "rss-shell" });
    const readerPane = shell.createDiv({ cls: "rss-reader-pane" });
    this.renderReader(readerPane, this.selectedRef());
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
      // The list lives in the right sidebar and this pane has no other way of
      // naming it, so a fresh install — or a sidebar the user folded shut —
      // lands on an empty reader with nothing to click. Offer the way in. While
      // the list is on screen the button would only repeat what is already
      // visible, so it is not built at all.
      if (!this.plugin.isListSidebarVisible()) {
        empty.createDiv({ cls: "rss-empty-hint", text: t("view.empty.listSidebar") });
        const actions = empty.createDiv({ cls: "rss-empty-actions" });
        textButton(actions, t("view.empty.showList"), "cta", () => {
          void this.plugin.toggleListSidebar();
        });
      }
      return;
    }

    const { article, feed } = ref;
    const header = pane.createDiv({ cls: "rss-reader-header" });

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
