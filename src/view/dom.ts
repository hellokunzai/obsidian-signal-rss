import { Platform, setIcon } from "obsidian";
import { toMoment } from "../core/time";

/** Small DOM helpers shared by the reader view and the sidebar copy of the list. */

export function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void
): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "clickable-icon rss-icon-button" });
  setIcon(button, icon);
  button.setAttribute("aria-label", label);
  button.setAttribute("data-tooltip-position", "bottom");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

export function textButton(
  parent: HTMLElement,
  label: string,
  kind: "normal" | "cta",
  onClick: () => void
): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: kind === "cta" ? "rss-button rss-button-cta" : "rss-button",
    text: label,
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

export function relativeTime(value: number): string {
  if (!value) return "";
  const m = toMoment(value);
  return m.isValid() ? m.fromNow() : "";
}

export function absoluteTime(value: number): string {
  if (!value) return "";
  const m = toMoment(value);
  return m.isValid() ? m.format("YYYY-MM-DD HH:mm") : "";
}

export function openExternal(url: string): void {
  if (!url) return;
  // A synthesized `<a target="_blank">` click is not reliably bridged to the
  // system browser inside Obsidian's mobile WebView; `window.open` is.
  if (Platform.isMobile) {
    window.open(url, "_blank");
    return;
  }
  const anchor = document.body.createEl("a", {
    href: url,
    attr: { target: "_blank", rel: "noopener noreferrer" },
  });
  anchor.click();
  anchor.remove();
}
