// Shared fetch plumbing for adapters: per-source User-Agent policy, pacing,
// 429 retry with Retry-After, timeouts, and typed errors. The UA table encodes
// hard-won lessons — ESPN 403s browser/custom UAs (experiment 009), MET Norway
// requires a descriptive UA (experiment 006), Reddit requires one too (005).

export class AdapterError extends Error {
  adapter: string;
  url: string;
  status?: number;
  retryable: boolean;
  constructor(adapter: string, url: string, message: string, status?: number, retryable = false) {
    super(message);
    this.adapter = adapter;
    this.url = url;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface FetchPolicy {
  /** Exact User-Agent to send. Omit to send none (undici default). */
  ua?: string;
  /** Extra headers (e.g. Authorization: Bearer). Merged over defaults. */
  headers?: Record<string, string>;
  /** Minimum gap between requests to the same host. */
  minGapMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Cap on honoring Retry-After; larger values throw instead of sleeping. */
  maxRetryAfterSec?: number;
}

const DEFAULT_POLICY: Required<FetchPolicy> = {
  ua: "",
  headers: {},
  minGapMs: 500,
  timeoutMs: 30_000,
  maxRetries: 3,
  maxRetryAfterSec: 120,
};

const lastHitAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pace(host: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const prev = lastHitAt.get(host) ?? 0;
  const wait = prev + gapMs - now;
  lastHitAt.set(host, Math.max(prev + gapMs, now));
  if (wait > 0) await sleep(wait);
}

export function userAgentFor(adapterId: string): string | undefined {
  if (adapterId.startsWith("weather.metno")) return "DetoxDashboard/0.1 (local personal project)";
  if (adapterId.startsWith("reddit.")) return "DetoxDashboard/0.1 (personal morning dashboard)";
  if (adapterId.startsWith("sports.espn")) return "curl/8.4.0";
  return undefined;
}

export async function fetchJson(
  adapterId: string,
  url: string,
  policy: FetchPolicy = {}
): Promise<unknown> {
  const p = { ...DEFAULT_POLICY, ...policy };
  const explicitUa = policy.ua !== undefined;
  const ua = explicitUa ? policy.ua : userAgentFor(adapterId);
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    attempt++;
    await pace(host, p.minGapMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), p.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          ...(ua ? { "User-Agent": ua, Accept: "application/json" } : { Accept: "application/json" }),
          ...p.headers,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt <= p.maxRetries) continue;
      throw new AdapterError(adapterId, url, `fetch failed: ${err instanceof Error ? err.message : err}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt <= p.maxRetries) {
      const waitSec = Number(res.headers.get("Retry-After") ?? "5");
      if (waitSec > p.maxRetryAfterSec) {
        throw new AdapterError(adapterId, url, `rate limited, Retry-After ${waitSec}s exceeds cap`, 429, false);
      }
      await sleep((waitSec + 1) * 1000);
      continue;
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempt <= p.maxRetries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new AdapterError(adapterId, url, `HTTP ${res.status}`, res.status, retryable);
    }
    return (await res.json()) as unknown;
  }
}

export async function fetchText(
  adapterId: string,
  url: string,
  policy: FetchPolicy = {},
  init?: RequestInit
): Promise<string> {
  const p = { ...DEFAULT_POLICY, ...policy };
  const ua = policy.ua !== undefined ? policy.ua : userAgentFor(adapterId);
  await pace(new URL(url).host, p.minGapMs);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        ...(ua ? { "User-Agent": ua } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new AdapterError(adapterId, url, `HTTP ${res.status}`, res.status, res.status >= 500);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
