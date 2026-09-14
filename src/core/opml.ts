import { t } from "../i18n";
import type { Feed, OpmlFeed } from "../types";

function localName(el: Element): string {
  const raw = el.localName || el.nodeName || "";
  const colon = raw.lastIndexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}

function findBody(root: Element): Element | null {
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (localName(all[i]) === "body") return all[i];
  }
  return null;
}

function walkOutlines(parent: Element, group: string, out: OpmlFeed[]): void {
  for (let i = 0; i < parent.children.length; i++) {
    const el = parent.children[i];
    if (localName(el) !== "outline") continue;
    const xmlUrl = el.getAttribute("xmlUrl") || el.getAttribute("xmlurl") || "";
    const title = el.getAttribute("title") || el.getAttribute("text") || "";
    if (xmlUrl) {
      out.push({
        title,
        xmlUrl,
        htmlUrl: el.getAttribute("htmlUrl") || el.getAttribute("htmlurl") || "",
        group,
      });
      continue;
    }
    const childGroup = title || group;
    walkOutlines(el, childGroup, out);
  }
}

export function parseOpml(xml: string): OpmlFeed[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || localName(root) === "parsererror") {
    throw new Error(t("error.invalidOpml"));
  }
  const out: OpmlFeed[] = [];
  const body = findBody(root);
  if (body) {
    walkOutlines(body, "", out);
  } else {
    walkOutlines(root, "", out);
  }
  return out.filter((feed) => /^https?:\/\//i.test(feed.xmlUrl));
}

function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function outline(feed: Feed, indent: string): string {
  const title = attr(feed.title || feed.url);
  const html = feed.siteUrl ? ` htmlUrl="${attr(feed.siteUrl)}"` : "";
  return `${indent}<outline type="rss" text="${title}" title="${title}" xmlUrl="${attr(feed.url)}"${html} />`;
}

export function buildOpml(feeds: Feed[], title: string): string {
  const groups = new Map<string, Feed[]>();
  for (const feed of feeds) {
    const key = feed.group || "";
    const list = groups.get(key);
    if (list) {
      list.push(feed);
    } else {
      groups.set(key, [feed]);
    }
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<opml version="2.0">');
  lines.push("  <head>");
  lines.push(`    <title>${attr(title)}</title>`);
  lines.push(`    <dateCreated>${new Date().toUTCString()}</dateCreated>`);
  lines.push("  </head>");
  lines.push("  <body>");
  for (const entry of groups) {
    const groupName = entry[0];
    const list = entry[1];
    if (!groupName) {
      for (const feed of list) lines.push(outline(feed, "    "));
      continue;
    }
    lines.push(`    <outline text="${attr(groupName)}" title="${attr(groupName)}">`);
    for (const feed of list) lines.push(outline(feed, "      "));
    lines.push("    </outline>");
  }
  lines.push("  </body>");
  lines.push("</opml>");
  return lines.join("\n");
}
