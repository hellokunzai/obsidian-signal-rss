import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export interface GroupNameModalOptions {
  title: string;
  /** Pre-filled name; empty for a fresh group, the current one when renaming. */
  value: string;
  submitLabel: string;
  /**
   * Handed the trimmed name. Returning false keeps the dialog open, which is how
   * a taken name becomes visible in place instead of closing on a no-op.
   */
  onSubmit: (name: string) => boolean;
}

/**
 * One text field and a pair of buttons, used for both "new group" and "rename
 * group": the two differ in wording and in what happens on submit, not in shape.
 */
export class GroupNameModal extends Modal {
  private options: GroupNameModalOptions;
  private inputValue: string;
  private errorEl: HTMLElement | null = null;
  private errorMessage = "";

  constructor(app: App, options: GroupNameModalOptions) {
    super(app);
    this.options = options;
    this.inputValue = options.value;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rss-group-name-modal");

    contentEl.createEl("h2", { text: this.options.title });

    new Setting(contentEl)
      .setName(t("modal.groupName.name"))
      .setDesc(t("modal.groupName.nameDesc"))
      .addText((text) => {
        text
          .setPlaceholder(t("modal.groupName.placeholder"))
          .setValue(this.inputValue)
          .onChange((value) => {
            this.inputValue = value;
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 20);
      });

    this.errorEl = contentEl.createDiv({ cls: "rss-add-feed-error" });
    this.renderError();

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(this.options.submitLabel)
          .setCta()
          .onClick(() => this.submit())
      )
      .addButton((button) =>
        button.setButtonText(t("modal.groupName.cancel")).onClick(() => this.close())
      );
  }

  private setError(message: string): void {
    this.errorMessage = message;
    this.renderError();
  }

  private renderError(): void {
    const el = this.errorEl;
    if (!el) return;
    el.empty();
    // Reuses the add-feed dialog's error block so both read the same way.
    el.toggleClass("is-hidden", !this.errorMessage);
    if (this.errorMessage) {
      el.createDiv({ cls: "rss-add-feed-error-message", text: this.errorMessage });
    }
  }

  private submit(): void {
    const name = this.inputValue.trim();
    if (!name) {
      this.setError(t("notice.groupNeedsName"));
      return;
    }
    if (!this.options.onSubmit(name)) {
      this.setError(t("notice.groupExists", { name }));
      return;
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
