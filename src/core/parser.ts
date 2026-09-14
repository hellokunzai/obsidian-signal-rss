import type { ParsedFeed, ParsedItem } from "../types";
import { escapeHtml } from "./sanitize";
import { t } from "../i18n";
import { toMoment } from "./time";

const DATE_FORMATS = [
  "ddd, DD MMM YYYY HH:mm:ss ZZ",
  "ddd, DD MMM YYYY HH:mm ZZ",
  "YYYY-MM-DDTHH:mm:ssZ",
  "YYYY-MM-DDTHH:mm:ssZZ",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DD",
];

function localName(el: Element): string {
  const raw = el.localName || el.nodeName || "";
  const colon = raw.lastIndexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}

function childEl(el: Element, ...names: string[]): Element | null {
  const wanted = names.map((n) => n.toLowerCase());
  for (let i = 0; i < el.children.length; i++) {
    const candidate = el.children[i];
    if (wanted.indexOf(localName(candidate)) >= 0) return candidate;
  }
  return null;
}

function childEls(el: Element, name: string): Element[] {
  const target = name.toLowerCase();
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const candidate = el.children[i];
    if (localName(candidate) === target) out.push(candidate);
  }
  return out;
}

function descendants(el: Element, name: string): Element[] {
  const target = name.toLowerCase();
  const out: Element[] = [];
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (localName(all[i]) === target) out.push(all[i]);
  }
  return out;
}

function textOf(el: Element | null): string {
  if (!el) return "";
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function rawOf(el: Element | null): string {
  if (!el) return "";
  return (el.textContent ?? "").trim();
}

function serializeChildren(el: Element): string {
  const serializer = new XMLSerializer();
  let out = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    out += serializer.serializeToString(el.childNodes[i]);
  }
  return out;
}

export function parseDate(value: string): number {
  if (!value) return 0;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const strict = toMoment(value, DATE_FORMATS, true);
  if (strict.isValid()) return strict.valueOf();
  const loose = toMoment(value, DATE_FORMATS, false);
  return loose.isValid() ? loose.valueOf() : 0;
}

function linkHref(el: Element): string {
  const links = childEls(el, "link");
  let fallback = "";
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    if (!href) continue;
    const rel = (link.getAttribute("rel") || "alternate").toLowerCase();
    if (rel === "alternate") return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

function pickContent(contentEl: Element | null, summaryEl: Element | null): string {
  if (!contentEl) return "";
  const type = (contentEl.getAttribute("type") || "html").toLowerCase();
  if (type === "xhtml") return serializeChildren(contentEl);
  if (type === "text") {
    const text = rawOf(contentEl);
    return text ? `<p>${escapeHtml(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>` : "";
  }
  return rawOf(contentEl);
}

function parseRssItem(item: Element): ParsedItem {
  const title = textOf(childEl(item, "title")) || textOf(childEl(item, "description")).slice(0, 80);
  const link = textOf(childEl(item, "link")) || linkHref(item) || textOf(childEl(item, "guid"));
  const guid = textOf(childEl(item, "guid")) || link || title;
  const author = textOf(childEl(item, "creator", "author")) || textOf(childEl(item, "author"));
  const publishedAt = parseDate(rawOf(childEl(item, "pubDate", "date", "published", "updated")));
  const description = rawOf(childEl(item, "description", "summary"));
  const content = pickContent(childEl(item, "encoded"), null) || description;
  return { title, link, guid, author, publishedAt, summary: description, content };
}

function parseAtomEntry(entry: Element): ParsedItem {
  const title = textOf(childEl(entry, "title"));
  const link = linkHref(entry);
  const guid = textOf(childEl(entry, "id")) || link || title;
  const authorEl = childEl(entry, "author");
  const author =
    textOf(authorEl ? childEl(authorEl, "name") : null) || textOf(authorEl);
  const publishedAt = parseDate(
    rawOf(childEl(entry, "published")) || rawOf(childEl(entry, "updated"))
  );
  const summary = rawOf(childEl(entry, "summary"));
  const content = pickContent(childEl(entry, "content"), null) || summary;
  return { title, link, guid, author, publishedAt, summary, content };
}

function parseAtom(root: Element): ParsedFeed {
  const entries = childEls(root, "entry");
  const feedLinks = childEls(root, "link");
  let siteUrl = "";
  for (const link of feedLinks) {
    const rel = (link.getAttribute("rel") || "alternate").toLowerCase();
    if (rel === "alternate") {
      siteUrl = link.getAttribute("href") || "";
      break;
    }
  }
  if (!siteUrl && feedLinks.length > 0) siteUrl = feedLinks[0].getAttribute("href") || "";
  if (!siteUrl) {
    const self = childEls(root, "link").find(
      (l) => (l.getAttribute("rel") || "").toLowerCase() === "self"
    );
    if (self) siteUrl = self.getAttribute("href") || "";
  }
  return {
    title: textOf(childEl(root, "title")),
    siteUrl,
    description: textOf(childEl(root, "subtitle", "description")),
    items: entries.map(parseAtomEntry),
  };
}

function parseRss(root: Element): ParsedFeed {
  const channel = childEl(root, "channel") ?? root;
  return {
    title: textOf(childEl(channel, "title")),
    siteUrl: textOf(childEl(channel, "link")) || linkHref(channel),
    description: textOf(childEl(channel, "description", "subtitle")),
    items: descendants(channel, "item").map(parseRssItem),
  };
}

function parseRdf(root: Element): ParsedFeed {
  const channel = childEl(root, "channel");
  const items = childEls(root, "item");
  return {
    title: textOf(channel ? childEl(channel, "title") : null),
    siteUrl: textOf(channel ? childEl(channel, "link") : null),
    description: textOf(channel ? childEl(channel, "description") : null),
    items: items.map((item) => {
      const parsed = parseRssItem(item);
      if (!parsed.link) parsed.link = item.getAttribute("rdf:about") || item.getAttribute("about") || "";
      if (!parsed.guid) parsed.guid = parsed.link;
      return parsed;
    }),
  };
}

export function parseFeedXml(xml: string): ParsedFeed {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || localName(root) === "parsererror") {
    throw new Error(t("error.invalidXml"));
  }
  const rootName = localName(root);
  if (rootName === "feed") return parseAtom(root);
  if (rootName === "rdf") return parseRdf(root);
  if (rootName === "rss") return parseRss(root);
  if (descendants(root, "item").length > 0) return parseRss(root);
  if (descendants(root, "entry").length > 0) return parseAtom(root);
  throw new Error(t("error.unsupportedFeed"));
}

export function looksLikeFeed(xml: string): boolean {
  try {
    parseFeedXml(xml);
    return true;
  } catch {
    return false;
  }
}

export function detectFeedLinks(html: string, baseUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found: string[] = [];
  const links = doc.getElementsByTagName("link");
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const type = (link.getAttribute("type") || "").toLowerCase();
    const href = link.getAttribute("href") || "";
    if (!href) continue;
    if (type.indexOf("rss") < 0 && type.indexOf("atom") < 0) continue;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (found.indexOf(absolute) < 0) found.push(absolute);
    } catch {
      continue;
    }
  }
  const anchors = doc.getElementsByTagName("a");
  for (let i = 0; i < anchors.length && found.length < 6; i++) {
    const href = anchors[i].getAttribute("href") || "";
    if (!/\.(rss|atom|xml)$/i.test(href) && href.indexOf("feed") < 0) continue;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (found.indexOf(absolute) < 0) found.push(absolute);
    } catch {
      continue;
    }
  }
  if (found.length === 0) {
    found.push(new URL("/feed", baseUrl).toString());
    found.push(new URL("/rss", baseUrl).toString());
  }
  return found.slice(0, 5);
}
