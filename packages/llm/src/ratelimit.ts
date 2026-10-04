import { LlmHttpError } from "./providers.js";

// Token bucket: the Gemini 5 RPM throttle lives here. Capacity 4 with a
// 15 s refill (= 4/min) leaves headroom under the 5/min cap. One bucket per
// provider id, module-level, so every stage in the process shares it.
// Throttled work waits and resumes — it is never restarted.

const buckets = new Map<string, { tokens: number; last: number }>();

export function resetRateLimiters(): void {
  buckets.clear();
}

export async function takeToken(providerId: string, rpm: number): Promise<void> {
  const capacity = Math.max(1, Math.min(4, rpm));
  const perTokenMs = 60_000 / Math.min(rpm, 4);
  let b = buckets.get(providerId);
  const now = Date.now();
  if (!b) {
    b = { tokens: capacity, last: now };
    buckets.set(providerId, b);
  }
  // Refill since last check.
  const elapsed = now - b.last;
  b.tokens = Math.min(capacity, b.tokens + elapsed / perTokenMs);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  const waitMs = Math.ceil((1 - b.tokens) * perTokenMs);
  await new Promise((r) => setTimeout(r, waitMs));
  b.tokens = 0;
  b.last = Date.now();
}

export interface BackoffOptions {
  retries?: number;
  baseMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

/** Retry with exponential backoff. 429/5xx and network errors retry;
// anything else (400, 401, 404) fails fast — retrying those burns budget. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const { retries = 2, baseMs = 1000, isRetryable } = opts;
  const retryable =
    isRetryable ??
    ((err: unknown) => {
      if (err instanceof LlmHttpError) return err.retryable;
      return err instanceof TypeError; // fetch network failure
    });
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt === retries || !retryable(err)) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
    }
  }
  throw last;
}
