import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import { VIEW_TYPE_RSS_SIDEBAR } from "./constants";
import { ListPane } from "./list-pane";

/**
 * A copy of the subscription list docked in the right sidebar. It renders the
 * same `ListPane` as the reader tab, so selection, filters and the search box
 * stay in lockstep with it — see `plugin.listState`.
 */
export class RssSidebarView extends ItemView {
  private pane: ListPane;
  private opened = false;

  constructor(leaf: WorkspaceLeaf, plugin: RssSubscribePlugin) {
    super(leaf);
    this.pane = new ListPane(plugin, { docked: true });
  }

  getViewType(): string {
    return VIEW_TYPE_RSS_SIDEBAR;
  }

  getDisplayText(): string {
    return t("view.sidebar.title");
  }

  getIcon(): string {
    return "rss";
  }

  async onOpen(): Promise<void> {
    this.opened = true;
    this.render();
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.pane.dispose();
  }

  refresh(): void {
    if (this.opened) this.render();
  }

  private render(): void {
    const container = this.contentEl;
    // Read the live scroll offsets and caret before wiping the DOM.
    this.pane.capture(container);
    container.empty();
    container.addClass("rss-subscribe-view");

    const shell = container.createDiv({ cls: "rss-shell" });
    // No toolbar here either — the group menus carry the bulk actions, and this
    // copy of the list has no switch to fold away.
    this.pane.render(shell.createDiv());
  }
}
