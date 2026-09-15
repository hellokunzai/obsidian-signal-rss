import { PluginSettingTab, Setting, setIcon } from "obsidian";
import type { App } from "obsidian";
import type RssSubscribePlugin from "./main";
import { t } from "./i18n";
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

export class RssSubscribeSettingTab extends PluginSettingTab {
  plugin: RssSubscribePlugin;

  /* Which tab is open. Instance state on purpose: it is a view preference, so it
     must not be written to data.json, and "reset settings" must not touch it. */
  private activeTab: SettingsTabId = "general";

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

  private tabDomId(id: SettingsTabId): string {
    return `rss-settings-tab-${id}`;
  }

  private selectTab(id: SettingsTabId): void {
    if (id === this.activeTab) {
      return;
    }
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
    new Setting(containerEl)
      .setName(t("settings.feeds.count", { count: String(this.plugin.store.feeds.length) }))
      .addButton((button) =>
        button.setButtonText(t("settings.button.import")).onClick(() => {
          void this.plugin.importOpmlFromFile();
        })
      )
      .addButton((button) =>
        button.setButtonText(t("settings.button.export")).onClick(() => {
          void this.plugin.exportOpml();
        })
      );

    const feeds: Feed[] = this.plugin.store.feeds;
    if (feeds.length === 0) {
      containerEl.createEl("p", {
        text: t("settings.feeds.empty"),
        cls: "rss-subscribe-settings-empty",
      });
      return;
    }

    for (const feed of feeds) {
      new Setting(containerEl)
        .setName(feed.title || feed.url)
        .setDesc(feed.group ? `${feed.group} · ${feed.url}` : feed.url)
        .addExtraButton((button) =>
          button
            .setIcon("refresh-cw")
            .setTooltip(t("view.action.refreshFeed"))
            .onClick(() => {
              void this.plugin.refreshFeed(feed, false);
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon("pencil")
            .setTooltip(t("view.action.editFeed"))
            .onClick(() => {
              new AddFeedModal(this.app, this.plugin, feed).open();
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon("trash-2")
            .setTooltip(t("view.action.deleteFeed"))
            .onClick(() => {
              void this.plugin.removeFeed(feed).then(() => this.display());
            })
        );
    }
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
