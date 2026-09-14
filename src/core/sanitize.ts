// Content sanitising and conversion.
//
// Feed payloads are arbitrary third-party markup. Nothing from a feed reaches
// the DOM or a Markdown note before it has been reduced to a small allowlist of
// tags and attributes. `innerHTML` is never used anywhere in this plugin.

import { sanitizeHTMLToDom } from "obsidian";

const DROP_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "noscript",
  "svg",
  "math",
  "link",
  "meta",
  "base",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "template",
  "dialog",
  "frame",
  "frameset",
  "portal",
];

const KEEP_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "code",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "mark",
  "small",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "div",
  "span",
  "section",
  "article",
  "main",
  "time",
];

const INLINE_KEEP = ["br", "code", "span", "a", "em", "strong", "b", "i", "u", "s", "sub", "sup"];

function nameOf(el: Element): string {
  const raw = el.localName || el.nodeName || "";
  const colon = raw.lastIndexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function resolveUrl(raw: string, baseUrl: string): string {
  const value = raw.trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:")
  ) {
    return "";
  }
  if (lower.startsWith("data:")) {
    return lower.startsWith("data:image/") ? value : "";
  }
  try {
    const url = new URL(value, baseUrl || "https://example.invalid/");
    const protocol = url.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeAttrs(el: Element, name: string, baseUrl: string): string {
  let out = "";
  if (name === "a") {
    const href = resolveUrl(el.getAttribute("href") || "", baseUrl);
    if (href) {
      out += ` href="${escapeAttr(href)}"`;
    }
    const title = el.getAttribute("title");
    if (title) out += ` title="${escapeAttr(title)}"`;
  } else if (name === "img") {
    const src = resolveUrl(
      el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-original") || "",
      baseUrl
    );
    if (src) {
      out += ` src="${escapeAttr(src)}"`;
    }
    out += ` alt="${escapeAttr(el.getAttribute("alt") || "")}"`;
    const width = el.getAttribute("width");
    if (width && /^\d{1,4}$/.test(width)) out += ` width="${width}"`;
    const height = el.getAttribute("height");
    if (height && /^\d{1,4}$/.test(height)) out += ` height="${height}"`;
  } else if (name === "td" || name === "th") {
    for (const attr of ["colspan", "rowspan"]) {
      const value = el.getAttribute(attr);
      if (value && /^\d{1,2}$/.test(value)) out += ` ${attr}="${value}"`;
    }
  }
  return out;
}

function walkSafe(node: Node, out: string[], baseUrl: string, depth: number, inPre: boolean): void {
  if (depth > 80) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue ?? "";
    if (inPre) {
      out.push(escapeHtml(value));
    } else {
      const collapsed = value.replace(/\s+/g, " ");
      if (collapsed.trim().length > 0 || collapsed === " ") out.push(escapeHtml(collapsed));
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const name = nameOf(el);
  if (DROP_TAGS.indexOf(name) >= 0) return;
  if (inPre && INLINE_KEEP.indexOf(name) < 0) {
    for (let i = 0; i < el.childNodes.length; i++) {
      walkSafe(el.childNodes[i], out, baseUrl, depth + 1, true);
    }
    return;
  }
  const allowed = KEEP_TAGS.indexOf(name) >= 0;
  const tag = allowed ? name : "";
  const attrs = allowed ? safeAttrs(el, name, baseUrl) : "";
  const selfClosing = name === "br" || name === "hr" || name === "img";
  const dropSelf = name === "img" && attrs.indexOf(" src=") < 0;
  if (dropSelf) return;
  if (tag) out.push(`<${tag}${attrs}>`);
  const nextInPre = inPre || name === "pre";
  for (let i = 0; i < el.childNodes.length; i++) {
    walkSafe(el.childNodes[i], out, baseUrl, depth + 1, nextInPre);
  }
  if (tag && !selfClosing) out.push(`</${tag}>`);
}

export function safeHtmlFromNode(node: Node, baseUrl: string): string {
  const out: string[] = [];
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    walkSafe(children[i], out, baseUrl, 0, false);
  }
  return out.join("");
}

export function safeHtml(html: string, baseUrl: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  return safeHtmlFromNode(body, baseUrl);
}

export function insertSafeHtml(parent: HTMLElement, html: string): void {
  if (!html) return;
  parent.appendChild(sanitizeHTMLToDom(html));
}

export function htmlToPlainText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  const blocks = body.querySelectorAll(
    "p, div, li, h1, h2, h3, h4, h5, h6, blockquote, section, article, tr, br"
  );
  for (let i = 0; i < blocks.length; i += 1) {
    blocks[i].appendChild(doc.createTextNode(" "));
  }
  const text = body.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function fenceFor(text: string, minimum = 1): string {
  let longest = 0;
  const runs = text.match(/`+/g);
  if (runs) {
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(minimum, longest + 1));
}

function escapeMdText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/`/g, "\\`");
}

interface MdCtx {
  out: string[];
}

function mdInline(el: Element | Node, ctx: MdCtx): void {
  if (el.nodeType === Node.TEXT_NODE) {
    ctx.out.push(escapeMdText(el.nodeValue ?? ""));
    return;
  }
  if (el.nodeType !== Node.ELEMENT_NODE) return;
  const element = el as Element;
  const name = nameOf(element);
  if (DROP_TAGS.indexOf(name) >= 0) return;
  switch (name) {
    case "br":
      ctx.out.push("  \n");
      return;
    case "img": {
      const src = element.getAttribute("src") || "";
      if (src) ctx.out.push(`![${element.getAttribute("alt") || ""}](${src})`);
      return;
    }
    case "a": {
      const href = element.getAttribute("href") || "";
      const label: string[] = [];
      for (let i = 0; i < element.childNodes.length; i++) {
        mdInline(element.childNodes[i], { out: label });
      }
      const text = label.join("").trim();
      if (href && text) ctx.out.push(`[${text}](${href})`);
      else if (href) ctx.out.push(`<${href}>`);
      else ctx.out.push(text);
      return;
    }
    case "code":
    case "kbd":
    case "samp": {
      const text = element.textContent ?? "";
      if (!text) return;
      const fence = fenceFor(text);
      ctx.out.push(`${fence}${text}${fence}`);
      return;
    }
    case "strong":
    case "b": {
      const inner: string[] = [];
      for (let i = 0; i < element.childNodes.length; i++) {
        mdInline(element.childNodes[i], { out: inner });
      }
      const text = inner.join("");
      ctx.out.push(text.trim() ? `**${text}**` : text);
      return;
    }
    case "em":
    case "i": {
      const inner: string[] = [];
      for (let i = 0; i < element.childNodes.length; i++) {
        mdInline(element.childNodes[i], { out: inner });
      }
      const text = inner.join("");
      ctx.out.push(text.trim() ? `*${text}*` : text);
      return;
    }
    case "del":
    case "s": {
      const inner: string[] = [];
      for (let i = 0; i < element.childNodes.length; i++) {
        mdInline(element.childNodes[i], { out: inner });
      }
      ctx.out.push(`~~${inner.join("")}~~`);
      return;
    }
    case "ul":
    case "ol":
      return;
    default: {
      for (let i = 0; i < element.childNodes.length; i++) {
        mdInline(element.childNodes[i], ctx);
      }
    }
  }
}

function mdBlocks(container: Node, ctx: MdCtx): void {
  const nodes = container.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = escapeMdText(node.nodeValue ?? "");
      if (text.trim()) ctx.out.push(text);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const name = nameOf(el);
    if (DROP_TAGS.indexOf(name) >= 0) continue;
    if (/^h[1-6]$/.test(name)) {
      const level = Number(name.charAt(1));
      const inner: string[] = [];
      mdInline(el, { out: inner });
      ctx.out.push(`\n\n${"#".repeat(level)} ${inner.join("").trim()}\n\n`);
      continue;
    }
    if (name === "ul" || name === "ol") {
      mdList(el, ctx, name === "ol", 0);
      continue;
    }
    if (name === "pre") {
      const codeEl = el.querySelector("code");
      const text = (codeEl ?? el).textContent ?? "";
      const trimmed = text.replace(/^\n+/, "").replace(/\s+$/, "");
      const fence = fenceFor(trimmed, 3);
      ctx.out.push(`\n\n${fence}\n${trimmed}\n${fence}\n\n`);
      continue;
    }
    if (name === "blockquote") {
      const inner: string[] = [];
      mdBlocks(el, { out: inner });
      const quoted = inner
        .join("")
        .trim()
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");
      ctx.out.push(`\n\n${quoted}\n\n`);
      continue;
    }
    if (name === "hr") {
      ctx.out.push("\n\n---\n\n");
      continue;
    }
    if (name === "table") {
      mdTable(el, ctx);
      continue;
    }
    if (name === "p" || name === "div" || name === "section" || name === "article" || name === "main" || name === "figure" || name === "figcaption" || name === "dd" || name === "dt" || name === "caption") {
      const hasBlockChild = Array.prototype.some.call(
        el.children,
        (child: Element) => {
          const childName = nameOf(child);
          return ["p", "div", "section", "article", "ul", "ol", "table", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"].indexOf(childName) >= 0;
        }
      );
      if (hasBlockChild) {
        mdBlocks(el, ctx);
      } else {
        const inner: string[] = [];
        mdInline(el, { out: inner });
        const text = inner.join("").trim();
        if (text) ctx.out.push(`\n\n${text}\n\n`);
      }
      continue;
    }
    mdInline(el, ctx);
  }
}

function mdList(list: Element, ctx: MdCtx, ordered: boolean, depth: number): void {
  const pad = "  ".repeat(depth);
  let index = 1;
  ctx.out.push("\n\n");
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    if (nameOf(li) !== "li") continue;
    const inline: string[] = [];
    const nested: Element[] = [];
    for (let j = 0; j < li.childNodes.length; j++) {
      const child = li.childNodes[j];
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childName = nameOf(child as Element);
        if (childName === "ul" || childName === "ol") {
          nested.push(child as Element);
          continue;
        }
      }
      mdInline(child, { out: inline });
    }
    const text = inline.join("").trim();
    ctx.out.push(`${pad}${ordered ? `${index}. ` : "- "}${text}\n`);
    for (const sub of nested) {
      mdList(sub, ctx, nameOf(sub) === "ol", depth + 1);
    }
    index++;
  }
  ctx.out.push("\n");
}

function mdTable(table: Element, ctx: MdCtx): void {
  const rows: Element[] = [];
  const collected = table.querySelectorAll("tr");
  for (let i = 0; i < collected.length; i++) rows.push(collected[i]);
  if (rows.length === 0) return;
  const cellText = (row: Element): string[] => {
    const cells: string[] = [];
    const children = row.children;
    for (let i = 0; i < children.length; i++) {
      const cell = children[i];
      const cellName = nameOf(cell);
      if (cellName !== "td" && cellName !== "th") continue;
      const inner: string[] = [];
      mdInline(cell, { out: inner });
      cells.push(inner.join("").trim().replace(/\|/g, "\\|").replace(/\n+/g, " ") || " ");
    }
    return cells;
  };
  const head = cellText(rows[0]);
  if (head.length === 0) return;
  ctx.out.push("\n\n");
  ctx.out.push(`| ${head.join(" | ")} |\n`);
  ctx.out.push(`| ${head.map(() => "---").join(" | ")} |\n`);
  for (let i = 1; i < rows.length; i++) {
    const cells = cellText(rows[i]);
    if (cells.length === 0) continue;
    while (cells.length < head.length) cells.push(" ");
    ctx.out.push(`| ${cells.slice(0, Math.max(head.length, cells.length)).join(" | ")} |\n`);
  }
  ctx.out.push("\n");
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  const ctx: MdCtx = { out: [] };
  mdBlocks(body, ctx);
  return ctx.out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeYaml(value: string): string {
  const clean = value.replace(/\r?\n/g, " ").replace(/"/g, '\\"').trim();
  return `"${clean}"`;
}
