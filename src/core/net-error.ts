// Normalizes low-level network failures (Chromium net errors, Node socket
// errors) into something a human can act on, and tags them so callers can tell
// "this host is unreachable" apart from "this response was not a feed".

import { t } from "../i18n";

export type NetworkFailureKind =
  | "timeout"
  | "dns"
  | "refused"
  | "unreachable"
  | "offline"
  | "tls"
  | "unknown";

export class NetworkError extends Error {
  readonly kind: NetworkFailureKind;
  readonly url: string;

  constructor(kind: NetworkFailureKind, message: string, url: string) {
    super(message);
    this.name = "NetworkError";
    this.kind = kind;
    this.url = url;
  }
}

interface FailurePattern {
  re: RegExp;
  kind: NetworkFailureKind;
}

// Order matters: the first match wins, so the more specific patterns come first.
const PATTERNS: FailurePattern[] = [
  {
    re: /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/i,
    kind: "dns",
  },
  {
    re: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i,
    kind: "refused",
  },
  {
    re: /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED|ENETUNREACH|ENETDOWN/i,
    kind: "offline",
  },
  {
    re: /ERR_CERT|ERR_SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED/i,
    kind: "tls",
  },
  {
    re: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_TIMEOUT|ETIMEDOUT|ECONNRESET/i,
    kind: "unreachable",
  },
];

// Keys are called literally so the i18n checker can see them.
function messageFor(kind: NetworkFailureKind): string {
  switch (kind) {
    case "dns":
      return t("error.dnsFailed");
    case "refused":
      return t("error.connectionRefused");
    case "offline":
      return t("error.offline");
    case "tls":
      return t("error.tls");
    case "unreachable":
      return t("error.unreachable");
    default:
      return "";
  }
}

export function toNetworkError(error: unknown, url: string): NetworkError {
  if (error instanceof NetworkError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  for (const pattern of PATTERNS) {
    if (pattern.re.test(raw)) {
      return new NetworkError(pattern.kind, messageFor(pattern.kind), url);
    }
  }
  return new NetworkError("unknown", raw, url);
}

export function timeoutError(url: string, timeoutMs: number): NetworkError {
  const seconds = String(Math.max(1, Math.round(timeoutMs / 1000)));
  return new NetworkError("timeout", t("error.requestTimedOut", { seconds }), url);
}

/**
 * True when the host itself could not be reached. Retrying a different path on
 * the same host would only burn another timeout, so callers should stop early.
 */
export function isUnreachable(error: unknown): boolean {
  return error instanceof NetworkError && error.kind !== "unknown";
}

/** Extra, non-error guidance shown next to a failed request. */
export function networkHint(error: unknown): string {
  return isUnreachable(error) ? t("error.networkHint") : "";
}
