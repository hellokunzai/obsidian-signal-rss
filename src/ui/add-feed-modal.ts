import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type RssSubscribePlugin from "../main";
import { t } from "../i18n";
import type { Feed } from "../types";

export class AddFeedModal extends Modal {
  private plugin: RssSubscribePlugin;
  private existing: Feed | null;
  private urlValue: string;
  private titleValue: string;
  private groupValue: string;

  // While a request is in flight the buttons are disabled, so a slow or hanging
  // feed cannot be queued up several times by impatient clicking.
  private busy = false;
  private errorMessage = "";
  private errorHint = "";

  private urlInput: TextComponent | null = null;
  private titleInput: TextComponent | null = null;
  private detectButton: ButtonComponent | null = null;
  private submitButton: ButtonComponent | null = null;
  private errorEl: HTMLElement | null = null;

  /**
   * `presetGroup` only applies to a *new* feed: it pre-fills the group field
   * when the modal is opened from that group's own menu. Editing an existing
   * feed always starts from the group that feed is actually in.
   */
  constructor(
    app: App,
    plugin: RssSubscribePlugin,
    existing: Feed | null = null,
    presetGroup = ""
  ) {
    super(app);
    this.plugin = plugin;
    this.existing = existing;
    this.urlValue = existing ? existing.url : "";
    this.titleValue = existing ? existing.title : "";
    this.groupValue = existing ? existing.group : presetGroup;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rss-add-feed-modal");

    contentEl.createEl("h2", {
      text: this.existing ? t("view.action.editFeed") : t("modal.addFeed.title"),
    });

    new Setting(contentEl)
      .setName(t("modal.addFeed.url"))
      .setDesc(t("modal.addFeed.urlDesc"))
      .addText((text) => {
        this.urlInput = text;
        text
          .setPlaceholder(t("modal.addFeed.urlPlaceholder"))
          .setValue(this.urlValue)
          .onChange((value) => {
            this.urlValue = value;
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.submit();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 20);
      })
      .addButton((button) => {
        this.detectButton = button;
        button.setButtonText(t("modal.addFeed.detect")).onClick(() => {
          void this.detect();
        });
      });

    this.errorEl = contentEl.createDiv({ cls: "rss-add-feed-error" });
    this.renderError();

    new Setting(contentEl)
      .setName(t("modal.addFeed.titleField"))
      .addText((text) => {
        this.titleInput = text;
        text
          .setPlaceholder(t("modal.addFeed.titlePlaceholder"))
          .setValue(this.titleValue)
          .onChange((value) => {
            this.titleValue = value;
          });
      });

    new Setting(contentEl).setName(t("modal.addFeed.group")).addText((text) =>
      text
        .setPlaceholder(t("modal.addFeed.groupPlaceholder"))
        .setValue(this.groupValue)
        .onChange((value) => {
          this.groupValue = value;
        })
    );

    new Setting(contentEl)
      .addButton((button) => {
        this.submitButton = button;
        button
          .setButtonText(this.existing ? t("modal.addFeed.save") : t("modal.addFeed.submit"))
          .setCta()
          .onClick(() => {
            void this.submit();
          });
      })
      .addButton((button) =>
        button.setButtonText(t("modal.addFeed.cancel")).onClick(() => this.close())
      );

    this.applyBusyState();
  }

  private applyBusyState(): void {
    if (this.detectButton) {
      this.detectButton.setDisabled(this.busy);
      this.detectButton.setButtonText(
        this.busy ? t("modal.addFeed.detecting") : t("modal.addFeed.detect")
      );
    }
    if (this.submitButton) {
      const idle = this.existing ? t("modal.addFeed.save") : t("modal.addFeed.submit");
      this.submitButton.setDisabled(this.busy);
      this.submitButton.setButtonText(this.busy ? t("modal.addFeed.adding") : idle);
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.applyBusyState();
  }

  private setError(message: string, hint = ""): void {
    this.errorMessage = message;
    this.errorHint = hint;
    this.renderError();
  }

  private clearError(): void {
    this.setError("");
  }

  private renderError(): void {
    const el = this.errorEl;
    if (!el) return;
    el.empty();
    if (!this.errorMessage) {
      el.toggleClass("is-hidden", true);
      return;
    }
    el.toggleClass("is-hidden", false);
    el.createDiv({ cls: "rss-add-feed-error-message", text: this.errorMessage });
    if (this.errorHint) {
      el.createDiv({ cls: "rss-add-feed-error-hint", text: this.errorHint });
    }
  }

  private async detect(): Promise<void> {
    if (this.busy) return;
    const value = this.urlValue.trim();
    if (!value) {
      new Notice(t("notice.feedNeedsUrl"));
      return;
    }
    this.clearError();
    this.setBusy(true);
    try {
      const result = await this.plugin.discoverInput(value);
      if (!result.ok) {
        this.setError(result.message, result.hint);
        return;
      }
      this.urlValue = result.url;
      this.urlInput?.setValue(result.url);
      if (!this.titleValue.trim() && result.title) {
        this.titleValue = result.title;
        this.titleInput?.setValue(result.title);
      }
      new Notice(t("notice.discoverFound", { title: result.title || result.url }));
    } finally {
      this.setBusy(false);
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (!this.urlValue.trim()) {
      new Notice(t("notice.feedNeedsUrl"));
      return;
    }
    this.clearError();
    this.setBusy(true);
    try {
      if (this.existing) {
        await this.plugin.editFeed(this.existing, {
          url: this.urlValue.trim(),
          title: this.titleValue.trim(),
          group: this.groupValue.trim(),
        });
        this.close();
        return;
      }
      const result = await this.plugin.addFeedFromInput(
        this.urlValue,
        this.titleValue.trim(),
        this.groupValue.trim()
      );
      if (result.ok) {
        this.close();
        return;
      }
      this.setError(result.message, result.hint);
    } finally {
      this.setBusy(false);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
