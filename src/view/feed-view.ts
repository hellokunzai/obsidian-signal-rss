import { ItemView, Menu, Notice, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import type { ArticleRef } from "../core/store";
import { insertSafeHtml } from "../core/sanitize";
import { VIEW_TYPE_RSS_SUBSCRIBE } from "./constants";
import { openExternal, textButton } from "./dom";

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
  /** Title shown on the tab and view header; reflects the picked article. */
  private displayTitle = t("view.title");

  constructor(leaf: WorkspaceLeaf, plugin: RssSubscribePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RSS_SUBSCRIBE;
  }

  getDisplayText(): string {
    return this.displayTitle;
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

    const { article } = ref;
    this.updateDisplayTitle(article.title || article.link || t("view.title"));

    const header = pane.createDiv({ cls: "rss-reader-header" });
    const titleRow = header.createDiv({ cls: "rss-reader-titlerow" });
    titleRow.createEl("h2", { cls: "rss-reader-title", text: article.title || article.link });

    // All per-article actions now live behind a single "more" trigger, so the
    // header stays uncluttered. The menu is an Obsidian Menu (see openReaderMenu).
    const more = titleRow.createEl("button", {
      cls: "clickable-icon rss-reader-more",
      attr: { "aria-label": t("view.action.more"), title: t("view.action.more") },
    });
    setIcon(more, "more-vertical");
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this.openReaderMenu(ev, ref);
    });

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

  /**
   * Reflect the picked article in the tab label and the centered view header.
   * Obsidian only reads getDisplayText() once when the leaf is built, so we push
   * the change to both DOM nodes directly. The runtime fields exist on
   * WorkspaceLeaf but are not in the type defs, hence the narrow cast.
   */
  private updateDisplayTitle(title: string): void {
    if (title === this.displayTitle) return;
    this.displayTitle = title;
    const leaf = this.leaf as unknown as {
      tabHeaderInnerTitleEl?: HTMLElement;
      viewHeaderTitleEl?: HTMLElement;
    };
    if (leaf.tabHeaderInnerTitleEl) leaf.tabHeaderInnerTitleEl.textContent = title;
    if (leaf.viewHeaderTitleEl) leaf.viewHeaderTitleEl.textContent = title;
  }

  private openReaderMenu(ev: MouseEvent, ref: ArticleRef): void {
    const { article, feed } = ref;
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle(article.starred ? t("view.action.unstar") : t("view.action.star"))
        .setIcon(article.starred ? "star-off" : "star")
        .onClick(() => {
          this.plugin.store.update(feed.id, article.id, { starred: !article.starred });
          this.plugin.store.markDirty(feed.id);
          void this.plugin.persistCache();
          this.plugin.notifyViews();
          this.plugin.updateRibbonBadge();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle(article.read ? t("view.action.markUnread") : t("view.action.markRead"))
        .setIcon(article.read ? "mail" : "mail-open")
        .onClick(() => {
          this.plugin.store.update(feed.id, article.id, { read: !article.read });
          this.plugin.store.markDirty(feed.id);
          void this.plugin.persistCache();
          this.plugin.notifyViews();
          this.plugin.updateRibbonBadge();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle(t("view.action.fetchFulltext"))
        .setIcon("download")
        .onClick(() => void this.forceFulltext(ref));
    });

    menu.addItem((item) => {
      item
        .setTitle(t("view.action.openExternal"))
        .setIcon("external-link")
        .onClick(() => openExternal(article.link));
    });

    menu.addSeparator();

    menu.addItem((item) => {
      const mi = item.setTitle(t("view.action.save")).setIcon("file-plus-2");
      // Echo the "already saved" hint that used to live in the removed meta row,
      // so the user can still see where the note went. setSubtitle exists on the
      // runtime MenuItem (Obsidian >=1.4) but is missing from the local typings.
      if (article.savedPath) {
        (mi as unknown as { setSubtitle?: (s: string) => void }).setSubtitle?.(
          t("view.meta.saved", { path: article.savedPath })
        );
      }
      mi.onClick(() => void this.plugin.saveArticle(ref));
    });

    menu.showAtMouseEvent(ev);
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
