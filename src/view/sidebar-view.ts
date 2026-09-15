import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import { VIEW_TYPE_RSS_SIDEBAR } from "./constants";
import { ListPane } from "./list-pane";

/**
 * The subscription list, docked in the right sidebar. This is the only host of
 * `ListPane` now: the reader tab renders the selected article and nothing else.
 *
 * Filter and selection state lives on the plugin (`plugin.listState`), so the
 * reader tab always renders whatever this pane last picked.
 */
export class RssSidebarView extends ItemView {
  private pane: ListPane;
  private opened = false;

  constructor(leaf: WorkspaceLeaf, plugin: RssSubscribePlugin) {
    super(leaf);
    this.pane = new ListPane(plugin);
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
    // No toolbar: the bulk actions hang off each group's own menu.
    this.pane.render(shell.createDiv());
  }
}
