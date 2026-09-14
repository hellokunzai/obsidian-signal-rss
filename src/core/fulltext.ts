// Very small readability-style extractor. It only has to be good enough to pull
// the article body out of a blog or news page, and it must never be a security
// boundary: the browser parser does the parsing, the allowlist in sanitize.ts
// decides what survives.

import { safeHtmlFromNode } from "./sanitize";

const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "select",
  "textarea",
  "button",
  "nav",
  "aside",
  "footer",
  "header",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[role=complementary]",
  "[role=search]",
  "[aria-hidden=true]",
  "[hidden]",
];

const NOISE_HINTS = [
  "comment",
  "sidebar",
  "side-bar",
  "footer",
  "header",
  "nav",
  "menu",
  "share",
  "social",
  "related",
  "recommend",
  "popular",
  "promo",
  "advert",
  "ads",
  "ad-",
  "-ad",
  "sponsor",
  "subscribe",
  "newsletter",
  "breadcrumb",
  "pagination",
  "pager",
  "toolbar",
  "cookie",
  "banner",
  "popup",
  "modal",
  "disclaimer",
  "tags",
  "byline",
];

const HINT_BONUS = [
  "article",
  "content",
  "post",
  "entry",
  "main",
  "story",
  "body",
  "text",
];

function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function hintText(el: Element): string {
  const cls = typeof el.className === "string" ? el.className : "";
  return `${cls} ${el.id}`.toLowerCase();
}

function score(el: Element, textLen: number): number {
  let value = textLen;
  const links = el.querySelectorAll("a");
  let linkText = 0;
  for (let i = 0; i < links.length; i++) {
    linkText += (links[i].textContent ?? "").length;
  }
  value -= linkText * 1.2;
  const tag = (el.localName || "").toLowerCase();
  if (tag === "article") value += 400;
  if (tag === "main") value += 250;
  const hints = hintText(el);
  for (const bad of NOISE_HINTS) {
    if (hints.indexOf(bad) >= 0) value -= 600;
  }
  for (const good of HINT_BONUS) {
    if (hints.indexOf(good) >= 0) value += 250;
  }
  value += el.querySelectorAll("p").length * 40;
  const paragraphs = el.querySelectorAll("p");
  let paragraphText = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    paragraphText += textLength(paragraphs[i]);
  }
  if (textLen > 0) value += (paragraphText / textLen) * textLen * 0.5;
  return value;
}

function unwrapSingleWrapper(el: Element): Element {
  let current = el;
  for (let depth = 0; depth < 3; depth += 1) {
    const children = current.children;
    const elementChildren: Element[] = [];
    for (let i = 0; i < children.length; i++) {
      const name = (children[i].localName || "").toLowerCase();
      if (name === "script" || name === "style") continue;
      elementChildren.push(children[i]);
    }
    if (elementChildren.length !== 1) break;
    const only = elementChildren[0];
    const name = (only.localName || "").toLowerCase();
    if (name !== "div" && name !== "section" && name !== "article" && name !== "main") break;
    if (textLength(only) < textLength(current) * 0.9) break;
    current = only;
  }
  return current;
}

export function extractArticleHtml(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";

  for (const selector of NOISE_SELECTORS) {
    const found = body.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) found[i].remove();
  }

  const candidates: Element[] = [];
  const pushed = body.querySelectorAll("article, main, [role=main], div, section, td");
  for (let i = 0; i < pushed.length; i++) candidates.push(pushed[i]);
  candidates.push(body);

  let best: Element = body;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const len = textLength(candidate);
    if (len < 200) continue;
    const value = score(candidate, len);
    if (value > bestScore) {
      bestScore = value;
      best = candidate;
    }
  }

  const target = unwrapSingleWrapper(best);
  if (textLength(target) < 200) return "";
  return safeHtmlFromNode(target, baseUrl);
}

export async function fetchArticleHtml(loader: (url: string) => Promise<string>, url: string): Promise<string> {
  const html = await loader(url);
  return extractArticleHtml(html, url);
}
