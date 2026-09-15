import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type RssSubscribePlugin from "./main";
import { t } from "./i18n";
import type { Feed } from "./types";
import { AddFeedModal } from "./ui/add-feed-modal";

export class RssSubscribeSettingTab extends PluginSettingTab {
  plugin: RssSubscribePlugin;

  constructor(app: App, plugin: RssSubscribePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("rss-subscribe-settings");

    this.renderGeneral(containerEl);
    this.renderReader(containerEl);
    this.renderNotes(containerEl);
    this.renderSubscriptions(containerEl);
    this.renderAbout(containerEl);
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
    new Setting(containerEl).setName(t("settings.section.notes")).setHeading();

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
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.addClass("rss-subscribe-template-input");
        area.setValue(this.plugin.settings.noteBodyTemplate).onChange(async (value) => {
          this.plugin.settings.noteBodyTemplate = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.openAfterSave.name"))
      .setDesc(t("settings.openAfterSave.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openAfterSave).onChange(async (value) => {
          this.plugin.settings.openAfterSave = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderSubscriptions(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.section.feeds")).setHeading();

    new Setting(containerEl)
      .setDesc(t("settings.feeds.count", { count: String(this.plugin.store.feeds.length) }))
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
    new Setting(containerEl).setName(t("settings.section.about")).setHeading();

    new Setting(containerEl).setName(
      t("settings.about.version", { version: this.plugin.manifest.version })
    );

    containerEl.createEl("p", { text: t("settings.about.network") });
    containerEl.createEl("p", { text: t("settings.about.security") });

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
