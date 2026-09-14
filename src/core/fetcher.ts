import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import type { ParsedFeed } from "../types";
import { t } from "../i18n";
import { detectFeedLinks, parseFeedXml } from "./parser";
import { isUnreachable, NetworkError, timeoutError, toNetworkError } from "./net-error";

export const DEFAULT_TIMEOUT_MS = 20000;

const FEED_HEADERS = {
  Accept:
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
  "User-Agent": "RSSSubscribe/0.1.0 (Obsidian plugin)",
};

const HTML_HEADERS = {
  Accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.8",
  "User-Agent": "Mozilla/5.0 (compatible; RSSSubscribe/0.1.0)",
};

export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("empty");
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
  return url.toString();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * requestUrl() has no timeout of its own, so a server that accepts the socket
 * and then never answers (a hung feed route, a black-holing firewall) would
 * leave the caller waiting forever. Race it against our own timer.
 */
async function requestWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<RequestUrlResponse> {
  const request = requestUrl({ url, method: "GET", headers, throw: false });
  if (timeoutMs <= 0) return request;

  let timer: number | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(timeoutError(url, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([request, expired]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    // A late rejection from the abandoned request must not surface as unhandled.
    request.catch(() => undefined);
  }
}

export async function fetchFeed(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ParsedFeed> {
  let response: RequestUrlResponse;
  try {
    response = await requestWithTimeout(url, FEED_HEADERS, timeoutMs);
  } catch (error) {
    throw toNetworkError(error, url);
  }
  if (response.status >= 400) {
    throw new Error(t("error.httpStatus", { status: String(response.status) }));
  }
  const text = response.text ?? "";
  if (!text.trim()) {
    throw new Error(t("error.emptyResponse"));
  }
  return parseFeedXml(text);
}

export async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  let response: RequestUrlResponse;
  try {
    response = await requestWithTimeout(url, HTML_HEADERS, timeoutMs);
  } catch (error) {
    throw toNetworkError(error, url);
  }
  if (response.status >= 400) {
    throw new Error(t("error.httpStatus", { status: String(response.status) }));
  }
  return response.text ?? "";
}

export interface DiscoveredFeed {
  url: string;
  feed: ParsedFeed;
}

/**
 * Accepts either a real feed URL or a site home page. Feed URLs are used
 * directly; otherwise the page is scanned for <link rel="alternate"> hints and
 * a handful of conventional paths.
 */
export async function discoverFeed(
  input: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<DiscoveredFeed> {
  const url = normalizeUrl(input);
  let firstError = "";
  try {
    const feed = await fetchFeed(url, timeoutMs);
    return { url, feed };
  } catch (error) {
    // Host is down or hanging: scraping the page would fail identically, so
    // fail now instead of spending a second timeout on it.
    if (isUnreachable(error)) throw error;
    firstError = describeError(error);
  }

  let html = "";
  try {
    html = await fetchText(url, timeoutMs);
  } catch (error) {
    if (isUnreachable(error)) throw error;
    throw new Error(firstError || describeError(error));
  }
  const candidates = detectFeedLinks(html, url);
  for (const candidate of candidates) {
    try {
      const feed = await fetchFeed(candidate, timeoutMs);
      return { url: candidate, feed };
    } catch {
      continue;
    }
  }
  throw new Error(firstError || t("error.noFeedFound"));
}

export { NetworkError };
