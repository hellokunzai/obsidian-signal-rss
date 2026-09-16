import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";
import type { Article, Feed, RssSubscribeSettings } from "../types";
import { escapeYaml, htmlToMarkdown, htmlToPlainText } from "../core/sanitize";
import { t } from "../i18n";
import { toMoment } from "../core/time";

const VAR_RE = /\{\{\s*([a-zA-Z#]+)\s*(?::([^}]*))?\}\}/g;

export interface NoteContext {
  title: string;
  link: string;
  author: string;
  feed: string;
  group: string;
  summary: string;
  content: string;
  publishedAt: number;
  createdAt: number;
}

function formatDate(value: number, format: string): string {
  if (!value) return "";
  const m = toMoment(value);
  return m.isValid() ? m.format(format) : "";
}

function wrap(modifier: string, value: string): string {
  return modifier.trim().toLowerCase() === "yaml" ? escapeYaml(value) : value;
}

export function renderTemplate(template: string, ctx: NoteContext): string {
  return template.replace(VAR_RE, (_match, rawName: string, rawArg?: string) => {
    const name = String(rawName).toLowerCase();
    const arg = (rawArg ?? "").trim();
    switch (name) {
      case "title":
        return wrap(arg, ctx.title);
      case "feed":
        return wrap(arg, ctx.feed);
      case "group":
        return wrap(arg, ctx.group);
      case "author":
        return wrap(arg, ctx.author);
      case "link":
        return ctx.link;
      case "summary":
        return ctx.summary;
      case "content":
        return ctx.content;
      case "published":
        return formatDate(ctx.publishedAt, arg || "YYYY-MM-DD");
      case "created":
        return formatDate(ctx.createdAt, arg || "YYYY-MM-DD");
      case "filename":
        return wrap(arg, ctx.title);
      case "tags":
        return "rss";
      default:
        return "";
    }
  });
}

export function safeFilename(name: string): string {
  let out = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  out = out.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out || t("common.untitled");
}

async function ensureFolder(app: App, folder: string): Promise<string> {
  const path = normalizePath(folder.trim()).replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const parts = path.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (error) {
        console.error(`Signal RSS: could not create the folder ${current}`, error);
      }
    }
  }
  return path;
}

function uniquePath(app: App, folder: string, base: string): string {
  const build = (suffix: string): string =>
    folder ? `${folder}/${base}${suffix}.md` : `${base}${suffix}.md`;
  let candidate = build("");
  let index = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = build(` ${index}`);
    index += 1;
  }
  return candidate;
}

export interface SaveResult {
  file: TFile;
  path: string;
}

export async function saveArticleAsNote(
  app: App,
  article: Article,
  feed: Feed,
  settings: RssSubscribeSettings,
  bodyHtml: string
): Promise<SaveResult> {
  const markdown = htmlToMarkdown(bodyHtml).trim();
  const ctx: NoteContext = {
    title: article.title || t("common.untitled"),
    link: article.link,
    author: article.author,
    feed: feed.title || feed.url,
    group: feed.group,
    summary: htmlToPlainText(article.summary),
    content: markdown,
    publishedAt: article.publishedAt,
    createdAt: Date.now(),
  };

  const frontmatter = renderTemplate(settings.frontmatterTemplate, ctx).trim();
  const body = renderTemplate(settings.noteBodyTemplate, ctx).trim();
  const document = `---\n${frontmatter}\n---\n\n${body}\n`;

  const folder = await ensureFolder(app, settings.noteFolder);
  const rawName = renderTemplate(settings.noteFilenameTemplate, ctx);
  const base = safeFilename(rawName || ctx.title);
  const path = uniquePath(app, folder, base);
  const file = await app.vault.create(path, document);
  return { file, path };
}
