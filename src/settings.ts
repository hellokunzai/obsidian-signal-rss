import { Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { App, ButtonComponent } from "obsidian";
import type RssSubscribePlugin from "./main";
import { t } from "./i18n";
import { DEFAULT_CACHE_FOLDER } from "./types";
import type { Feed } from "./types";
import { AddFeedModal } from "./ui/add-feed-modal";

type SettingsTabId = "general" | "feeds" | "notes" | "about";

interface SettingsTabDef {
  id: SettingsTabId;
  labelKey: string;
  icon: string;
}

/* Icon ids are not free-form. Obsidian ships a trimmed Lucide subset and the
   obvious choices are missing: `settings` (the gear), `rss` (the broadcast
   arcs) and `info` (the circled i) all fail to resolve, and an unresolved id
   renders as an empty svg slot rather than throwing.

   The way to get this wrong is to grep the asar: `"info":` does match, exactly
   once, inside an unrelated switch statement, which reads like a hit and is
   not one. The only trustworthy check is to lift the icon registry object out
   of obsidian.asar and look the key up in it (1343 names on 1.13). Every id
   below is in that list; `badge-info` is standing in for the missing `info`,
   and it draws an "i" inside a badge rather than `circle-help`'s "?", which
   would read as a help button. */
const SETTINGS_TABS: SettingsTabDef[] = [
  { id: "general", labelKey: "settings.tab.general", icon: "sliders-horizontal" },
  { id: "feeds", labelKey: "settings.tab.feeds", icon: "radio-tower" },
  { id: "notes", labelKey: "settings.tab.notes", icon: "file-text" },
  { id: "about", labelKey: "settings.tab.about", icon: "badge-info" },
];

const PANEL_ID = "rss-subscribe-settings-panel";

/* How long the cache folder field waits after the last keystroke before the
   store is re-pointed at it. Applying on every keystroke would create a folder
   per half-typed path and empty the article list on the way, so the value is
   only acted on once the typing has stopped — and, independently, on blur or
   Enter for the user who wants it to happen right now. */
const CACHE_FOLDER_DEBOUNCE_MS = 600;

/* Matching is done on a lowercased haystack built per call rather than on a
   cached index: the list is rebuilt from live plugin state anyway, and a cache
   here would be one more thing to invalidate after an OPML import. */
function feedMatches(feed: Feed, query: string): boolean {
  return `${feed.title} ${feed.group ?? ""} ${feed.url}`.toLowerCase().includes(query);
}

export class RssSubscribeSettingTab extends PluginSettingTab {
  plugin: RssSubscribePlugin;

  /* Which tab is open. Instance state on purpose: it is a view preference, so it
     must not be written to data.json, and "reset settings" must not touch it. */
  private activeTab: SettingsTabId = "general";

  /* The subscriptions search box is instance state for the same reason: it is a
     transient filter over the list, not a preference. Persisting it would let a
     stale query survive a restart with nothing on screen explaining it.
     Surviving a tab switch does matter, so it is a field rather than a local. */
  private feedQuery = "";

  /* Refs into the panel that is currently on screen. `display()` throws the whole
     tab away and redraws it, so these are re-pointed on every render and are only
     ever read by the handlers below — each of which checks `isConnected` first,
     because a slow refresh can land after the user has switched tabs. */
  private feedTableEl: HTMLElement | null = null;
  private feedRowsEl: HTMLElement | null = null;
  private feedCountEl: HTMLElement | null = null;
  private feedEmptyEl: HTMLElement | null = null;
  private feedSearchBoxEl: HTMLElement | null = null;

  /* The cache folder field, and the timer that settles it. Both belong to the
     tab instance rather than to a render, because `display()` throws the field
     away and the pending keystrokes have to survive that. */
  private cacheFolderInputEl: HTMLInputElement | null = null;
  private cacheFolderTimer: number | null = null;

  constructor(app: App, plugin: RssSubscribePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("rss-subscribe-settings");

    this.renderTabBar(containerEl);

    const panel = containerEl.createDiv({ cls: "rss-settings-body" });
    panel.id = PANEL_ID;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", this.tabDomId(this.activeTab));

    if (this.activeTab === "feeds") {
      this.renderSubscriptions(panel);
    } else if (this.activeTab === "notes") {
      this.renderNotes(panel);
    } else if (this.activeTab === "about") {
      this.renderAbout(panel);
    } else {
      this.renderGeneral(panel);
      this.renderReader(panel);
    }
  }

  /**
   * Closing the settings tab settles the folder the same way a tab switch
   * does: the panel is destroyed, no `blur` fires, and the debounce would
   * otherwise be the only thing left holding a half-typed value.
   */
  hide(): void {
    this.applyCacheFolderNow();
    super.hide();
  }

  private tabDomId(id: SettingsTabId): string {
    return `rss-settings-tab-${id}`;
  }

  private selectTab(id: SettingsTabId): void {
    if (id === this.activeTab) {
      return;
    }
    /* The panel and its field are about to be thrown away, and removing a
       focused input from the DOM fires no `blur` — so settle the folder here
       rather than leaving a typed value the store never picked up. */
    this.applyCacheFolderNow();
    this.activeTab = id;
    /* A full re-render is the cheapest correct move here: `display()` already
       knows how to draw a panel, and every control in it reads live plugin
       state, so there is nothing worth preserving across the swap. */
    this.display();
    /* That swap replaced the button that was clicked, which would drop focus to
       <body> and lose the keyboard user's place. Put it on the tab that is now
       open instead. */
    this.containerEl.querySelector<HTMLElement>(`#${this.tabDomId(id)}`)?.focus();
  }

  private renderTabBar(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: "rss-settings-tabs" });
    bar.setAttribute("role", "tablist");

    for (const tab of SETTINGS_TABS) {
      const isActive = tab.id === this.activeTab;
      const button = bar.createEl("button", {
        cls: "rss-settings-tab",
        attr: {
          type: "button",
          role: "tab",
          id: this.tabDomId(tab.id),
          "aria-controls": PANEL_ID,
          "aria-selected": String(isActive),
        },
      });
      button.toggleClass("is-active", isActive);
      /* Roving tabindex: the tablist is one Tab stop, and the arrow keys move
         between the tabs inside it — which is what a tablist is meant to do. */
      button.tabIndex = isActive ? 0 : -1;
      setIcon(button, tab.icon);
      button.createSpan({ text: t(tab.labelKey) });
      button.addEventListener("click", () => this.selectTab(tab.id));
    }

    bar.addEventListener("keydown", (event: KeyboardEvent) => {
      const ids = SETTINGS_TABS.map((tab) => tab.id);
      const current = ids.indexOf(this.activeTab);
      let next = current;
      if (event.key === "ArrowLeft") {
        next = (current - 1 + ids.length) % ids.length;
      } else if (event.key === "ArrowRight") {
        next = (current + 1) % ids.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = ids.length - 1;
      } else {
        return;
      }
      /* Arrow keys would otherwise scroll the settings page sideways. */
      event.preventDefault();
      this.selectTab(ids[next]);
    });
  }

  private renderGeneral(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.section.general")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.refreshInterval.name"))
      .setDesc(t("settings.refreshInterval.desc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "1440";
        text.inputEl.setAttribute("aria-label", t("settings.refreshInterval.suffix"));
        text.setValue(String(this.plugin.settings.refreshIntervalMinutes));
        text.onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.refreshIntervalMinutes = Number.isFinite(parsed)
            ? Math.max(0, Math.min(1440, parsed))
            : 0;
          await this.plugin.saveSettings();
          this.plugin.applyScheduler();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.requestTimeout.name"))
      .setDesc(t("settings.requestTimeout.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.requestTimeoutSeconds)
          .onChange(async (value) => {
            this.plugin.settings.requestTimeoutSeconds = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.maxArticles.name"))
      .setDesc(t("settings.maxArticles.desc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "20";
        text.inputEl.max = "2000";
        text.inputEl.setAttribute("aria-label", t("settings.maxArticles.suffix"));
        text.setValue(String(this.plugin.settings.maxArticlesPerFeed));
        text.onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxArticlesPerFeed = Number.isFinite(parsed)
            ? Math.max(20, Math.min(2000, parsed))
            : 200;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.markReadOnOpen.name"))
      .setDesc(t("settings.markReadOnOpen.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.markReadOnOpen).onChange(async (value) => {
          this.plugin.settings.markReadOnOpen = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.fetchFulltextOnOpen.name"))
      .setDesc(t("settings.fetchFulltextOnOpen.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.fetchFulltextOnOpen).onChange(async (value) => {
          this.plugin.settings.fetchFulltextOnOpen = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.fetchFulltextOnRefresh.name"))
      .setDesc(t("settings.fetchFulltextOnRefresh.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.fetchFulltextOnRefresh).onChange(async (value) => {
          this.plugin.settings.fetchFulltextOnRefresh = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.cacheFolder.name"))
      .setDesc(t("settings.cacheFolder.desc"))
      .addText((text) => {
        text.inputEl.setAttribute("aria-label", t("settings.cacheFolder.name"));
        text.inputEl.setAttribute("autocomplete", "off");
        text.inputEl.setAttribute("spellcheck", "false");
        text.setPlaceholder(DEFAULT_CACHE_FOLDER);
        text.setValue(this.plugin.settings.cacheFolder);
        text.onChange(async (value) => {
          /* Written straight through so the text cannot be lost, but only
             applied to the store once the typing has settled. */
          this.plugin.settings.cacheFolder = value;
          await this.plugin.saveSettings();
          this.scheduleCacheFolderApply();
        });
        text.inputEl.addEventListener("blur", () => this.applyCacheFolderNow());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          this.applyCacheFolderNow();
        });
        this.cacheFolderInputEl = text.inputEl;
      })
      .addButton((button) => {
        button.buttonEl.addClass("rss-toolbar-btn");
        button.setButtonText(t("settings.cacheFolder.migrate")).onClick(() => {
          void this.runCacheMigration(button);
        });
      });
  }

  /* ---------- cache folder ---------- */

  private scheduleCacheFolderApply(): void {
    this.cancelCacheFolderApply();
    this.cacheFolderTimer = window.setTimeout(() => {
      this.cacheFolderTimer = null;
      void this.plugin.applyCacheFolder().then(() => this.syncCacheFolderInput());
    }, CACHE_FOLDER_DEBOUNCE_MS);
  }

  private applyCacheFolderNow(): void {
    this.cancelCacheFolderApply();
    void this.plugin.applyCacheFolder().then(() => this.syncCacheFolderInput());
  }

  private cancelCacheFolderApply(): void {
    if (this.cacheFolderTimer === null) return;
    window.clearTimeout(this.cacheFolderTimer);
    this.cacheFolderTimer = null;
  }

  /** Show the path that is actually in use, once it differs from what is typed. */
  private syncCacheFolderInput(): void {
    const input = this.cacheFolderInputEl;
    if (!input || !input.isConnected) return;
    const applied = this.plugin.settings.cacheFolder;
    if (input.value !== applied) input.value = applied;
  }

  private async runCacheMigration(button: ButtonComponent): Promise<void> {
    if (button.buttonEl.disabled) return;
    this.cancelCacheFolderApply();
    button.setDisabled(true);
    button.setButtonText(t("settings.cacheFolder.migrating"));
    try {
      const result = await this.plugin.migrateCache();
      if (!result.ok) {
        new Notice(t("notice.cacheMigrateFailed", { message: result.message }));
      } else if (result.feeds === 0) {
        new Notice(t("notice.cacheMigrateEmpty"));
      } else {
        new Notice(
          t("notice.cacheMigrated", {
            feeds: String(result.feeds),
            articles: String(result.articles),
          })
        );
      }
    } finally {
      button.setDisabled(false);
      button.setButtonText(t("settings.cacheFolder.migrate"));
      this.syncCacheFolderInput();
    }
  }

  private renderReader(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.section.reader")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.fontSize.name"))
      .setDesc(t("settings.fontSize.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(12, 24, 1)
          .setValue(this.plugin.settings.readerFontSize)
          .onChange(async (value) => {
            this.plugin.settings.readerFontSize = value;
            await this.plugin.saveSettings();
            this.plugin.notifyViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.lineHeight.name"))
      .setDesc(t("settings.lineHeight.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(1.2, 2.2, 0.05)
          .setValue(this.plugin.settings.readerLineHeight)
          .onChange(async (value) => {
            this.plugin.settings.readerLineHeight = value;
            await this.plugin.saveSettings();
            this.plugin.notifyViews();
          })
      );
  }

  private renderNotes(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(t("settings.openAfterSave.name"))
      .setDesc(t("settings.openAfterSave.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openAfterSave).onChange(async (value) => {
          this.plugin.settings.openAfterSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.noteFolder.name"))
      .setDesc(t("settings.noteFolder.desc"))
      .addText((text) =>
        text.setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
          this.plugin.settings.noteFolder = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.noteFilename.name"))
      .setDesc(t("settings.noteFilename.desc"))
      .addText((text) =>
        text.setValue(this.plugin.settings.noteFilenameTemplate).onChange(async (value) => {
          this.plugin.settings.noteFilenameTemplate = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.frontmatter.name"))
      .setDesc(t("settings.frontmatter.desc"))
      .setClass("rss-subscribe-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 8;
        area.inputEl.addClass("rss-subscribe-template-input");
        area.setValue(this.plugin.settings.frontmatterTemplate).onChange(async (value) => {
          this.plugin.settings.frontmatterTemplate = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.noteBody.name"))
      .setDesc(t("settings.noteBody.desc"))
      .setClass("rss-subscribe-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.addClass("rss-subscribe-template-input");
        area.setValue(this.plugin.settings.noteBodyTemplate).onChange(async (value) => {
          this.plugin.settings.noteBodyTemplate = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderSubscriptions(containerEl: HTMLElement): void {
    /* The tab already says "subscriptions", so this row leads with the count
       instead of repeating the word as a section heading. */
    const toolbar = new Setting(containerEl)
      .setName(t("settings.feeds.count", { count: String(this.plugin.store.feeds.length) }))
      /* Named so the narrow-width rule in `styles.css` can stack this one row
         without touching the other `setting-item` rows in the tab. */
      .setClass("rss-feed-toolbar");
    this.feedCountEl = toolbar.nameEl;

    /* All three get the same explicit class because Obsidian's own button
       defaults (grey fill + inset shadow) do not match the bordered buttons the
       rest of this panel is drawn with. See `styles.css`. */
    toolbar.addButton((button) => {
      button.buttonEl.addClass("rss-toolbar-btn");
      button.setButtonText(t("settings.button.import")).onClick(() => {
        void this.plugin.importOpmlFromFile();
      });
    });
    toolbar.addButton((button) => {
      button.buttonEl.addClass("rss-toolbar-btn");
      button.setButtonText(t("settings.button.export")).onClick(() => {
        void this.plugin.exportOpml();
      });
    });
    toolbar.addButton((button) => {
      button.buttonEl.addClass("rss-toolbar-btn");
      button.setButtonText(t("settings.button.add")).onClick(() => {
        this.plugin.openAddFeedModal(null);
      });
    });

    this.renderFeedSearch(containerEl);

    const table = containerEl.createDiv({ cls: "rss-feed-table" });
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", t("settings.tab.feeds"));

    const head = table.createDiv({ cls: "rss-feed-thead" });
    head.setAttribute("role", "row");
    /* Three separate calls rather than a loop over a key list: `t()` has to see
       string literals, and a computed key would read as an unused translation. */
    const column = (label: string): void => {
      head.createSpan({ text: label, attr: { role: "columnheader" } });
    };
    column(t("settings.feeds.column.title"));
    column(t("settings.feeds.column.group"));
    column(t("settings.feeds.column.actions"));

    const rows = table.createDiv({ cls: "rss-feed-rows" });
    rows.setAttribute("role", "rowgroup");

    const empty = containerEl.createEl("p", {
      cls: "rss-feed-empty",
      text: t("settings.feeds.empty"),
    });

    this.feedTableEl = table;
    this.feedRowsEl = rows;
    this.feedEmptyEl = empty;

    this.renderFeedRows();
  }

  /* ---------- subscriptions: search box ---------- */

  private renderFeedSearch(containerEl: HTMLElement): void {
    const box = containerEl.createDiv({ cls: "rss-feed-search" });
    const text = box.createDiv({ cls: "rss-feed-search-text" });
    text.createDiv({ cls: "rss-feed-search-name", text: t("settings.feeds.search.name") });
    text.createDiv({ cls: "rss-feed-search-desc", text: t("settings.feeds.search.desc") });

    const field = box.createDiv({ cls: "rss-feed-search-field" });
    const input = field.createEl("input", {
      type: "text",
      cls: "rss-feed-search-input",
      placeholder: t("settings.feeds.search.placeholder"),
    });
    input.value = this.feedQuery;
    input.setAttribute("aria-label", t("settings.feeds.search.name"));
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.addEventListener("input", () => {
      this.feedQuery = input.value;
      /* Only the rows are repainted, never the box itself: rebuilding the input
         on every keystroke would drop the caret. */
      this.syncFeedSearchState();
      this.renderFeedRows();
    });

    const clear = field.createEl("button", { cls: "rss-feed-search-clear" });
    clear.setAttribute("type", "button");
    clear.setAttribute("aria-label", t("settings.feeds.search.clear"));
    clear.setAttribute("data-tooltip-position", "bottom");
    setIcon(clear, "x");
    clear.addEventListener("click", () => {
      this.feedQuery = "";
      input.value = "";
      input.focus();
      this.syncFeedSearchState();
      this.renderFeedRows();
    });

    this.feedSearchBoxEl = box;
    this.syncFeedSearchState();
  }

  /* The clear button is only worth showing once there is something to clear. */
  private syncFeedSearchState(): void {
    if (!this.feedSearchBoxEl || !this.feedSearchBoxEl.isConnected) return;
    this.feedSearchBoxEl.toggleClass("has-query", this.feedQuery.length > 0);
  }

  /* ---------- subscriptions: the list ---------- */

  private renderFeedRows(): void {
    const rows = this.feedRowsEl;
    if (!rows || !rows.isConnected) return;

    const feeds = this.plugin.store.feeds;
    const query = this.feedQuery.trim().toLowerCase();
    const visible = query ? feeds.filter((feed) => feedMatches(feed, query)) : feeds;

    rows.empty();
    if (this.feedTableEl) this.feedTableEl.hidden = feeds.length === 0;
    if (this.feedEmptyEl) this.feedEmptyEl.hidden = feeds.length > 0;
    this.feedCountEl?.setText(
      t("settings.feeds.count", { count: String(feeds.length) })
    );

    if (feeds.length === 0) return;

    if (visible.length === 0) {
      rows.createEl("p", {
        cls: "rss-feed-empty",
        text: t("settings.feeds.noMatch", { query: this.feedQuery.trim() }),
      });
      return;
    }

    for (const feed of visible) this.appendFeedRow(rows, feed);
  }

  /* Title / group / actions. The address rides along under the title instead of
     getting a column of its own: at the width the settings modal actually
     offers, a fourth column squeezes the address down to a few characters, and
     the address is the least interesting of the four. */
  private appendFeedRow(parent: HTMLElement, feed: Feed): void {
    const row = parent.createDiv({ cls: "rss-feed-row" });
    row.setAttribute("role", "row");

    const titleCell = row.createDiv({ cls: "rss-feed-cell" });
    titleCell.setAttribute("role", "cell");
    titleCell.createSpan({ cls: "rss-feed-title", text: feed.title || feed.url });
    titleCell.createSpan({ cls: "rss-feed-urlline", text: feed.url });

    const groupCell = row.createDiv({ cls: "rss-feed-cell" });
    groupCell.setAttribute("role", "cell");
    groupCell
      .createSpan({ cls: "rss-feed-group", text: feed.group || t("view.uncategorized") })
      .toggleClass("is-none", !feed.group);

    const actionCell = row.createDiv({ cls: "rss-feed-cell" });
    actionCell.setAttribute("role", "cell");
    const actions = actionCell.createDiv({ cls: "rss-feed-actions" });

    this.appendFeedAction(actions, "refresh-cw", t("view.action.refreshFeed"), () => {
      void this.plugin.refreshFeed(feed, false).then(() => this.renderFeedRows());
    });
    this.appendFeedAction(actions, "pencil", t("view.action.editFeed"), () => {
      new AddFeedModal(this.app, this.plugin, feed).open();
    });
    this.appendFeedAction(
      actions,
      "trash-2",
      t("view.action.deleteFeed"),
      () => {
        void this.plugin.removeFeed(feed).then(() => this.renderFeedRows());
      },
      true
    );
  }

  private appendFeedAction(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    danger = false
  ): void {
    const button = parent.createEl("button", { cls: "rss-feed-action" });
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip-position", "bottom");
    button.toggleClass("is-danger", danger);
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
  }

  private renderAbout(containerEl: HTMLElement): void {
    /* No section heading: the tab already reads "About", so a heading repeating
       the same word right under it is noise. The subscriptions and note-export
       tabs carry no heading for the same reason; only the general tab still has
       them, because it holds two distinct groups (general and reader). */
    new Setting(containerEl).setName(
      t("settings.about.version", { version: this.plugin.manifest.version })
    );

    new Setting(containerEl)
      .setName(t("settings.reset.name"))
      .setDesc(t("settings.reset.desc"))
      .addButton((button) =>
        button.setButtonText(t("settings.reset.button")).onClick(async () => {
          await this.plugin.resetSettings();
          this.display();
        })
      );
  }
}
