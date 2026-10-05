import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson, fetchText, AdapterError } from "../http.js";
import { ID, type ResolvedHolding } from "./yahoo.js";

// quoteSummary earnings via a manual cookie+crumb handshake (experiment 008).
// Deliberately NOT yahoo-finance2: one endpoint, ~15 lines of handshake,
// zero new dependencies. The crumb endpoint throttles aggressively, so the
// crumb is cached on disk (~12 h) and earnings degrade to news-only with a
// lane note when Yahoo refuses — retried on the next run.

interface CrumbCache {
  crumb: string;
  cookie: string;
  savedAt: string;
}

const CRUMB_TTL_MS = 12 * 3600_000;

function cachePath(dataDir: string): string {
  return join(dataDir, "cache", "yahoo-crumb.json");
}

function readCrumb(dataDir: string): CrumbCache | null {
  try {
    const raw = readFileSync(cachePath(dataDir), "utf8");
    const c = JSON.parse(raw) as CrumbCache;
    if (!c.crumb || !c.cookie) return null;
    if (Date.now() - Date.parse(c.savedAt) > CRUMB_TTL_MS) return null;
    return c;
  } catch {
    return null;
  }
}

function writeCrumb(dataDir: string, c: CrumbCache): void {
  mkdirSync(join(dataDir, "cache"), { recursive: true });
  writeFileSync(cachePath(dataDir), JSON.stringify(c));
}

async function freshCrumb(): Promise<CrumbCache> {
  // fc.yahoo.com 404s but still sets the A3 cookie; a full quote page works
  // as the cookie source when fc yields nothing.
  let jar = "";
  for (const url of ["https://fc.yahoo.com", "https://finance.yahoo.com/quote/AAPL"]) {
    const r = await fetch(url, { headers: { "User-Agent": "DetoxDashboard/0.1 (personal morning dashboard)" } });
    await r.text().catch(() => {});
    const setCookies: string[] = typeof (r.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (r.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [];
    jar = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (jar) break;
  }
  if (!jar) throw new Error("no Yahoo cookies issued");
  const r = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": "DetoxDashboard/0.1 (personal morning dashboard)", Cookie: jar },
  });
  if (!r.ok) throw new Error(`getcrumb HTTP ${r.status}`);
  const crumb = (await r.text()).trim();
  if (!crumb || crumb.length > 60 || crumb.includes(" ")) throw new Error("getcrumb returned no crumb");
  return { crumb, cookie: jar, savedAt: new Date().toISOString() };
}

export interface UpcomingEarning {
  date: string;
  estimated: boolean;
}

export interface RecentResult {
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  revActual: number | null;
  revEstimate: number | null;
}

export interface EarningsInfo {
  yahooSymbol: string;
  longName: string;
  currency: string;
  upcoming: UpcomingEarning[];
  recent: RecentResult[];
  thinData: boolean;
}

function unescapeStore(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\//g, "/");
}

/** Balanced-bracket slice starting at the opening bracket index. */
function bracketSlice(text: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < Math.min(openIdx + 60000, text.length); i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * Fallback earnings source: the quote page HTML embeds the same store
 * (calendarEvents + earningsChart) with no crumb required. Anchored on the
 * earningsChart object so financialsChart's quarterly never leaks in;
 * earningsDate takes the first occurrence (related-ticker lists carry no
 * calendar events). Returns a quoteSummary-shaped result for parseEarnings,
 * or null when the page lacks the store.
 */
export function extractQuotePage(html: string, yahooSymbol: string): Record<string, unknown> | null {
  const esc = yahooSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const title = html.match(new RegExp(`<title>(.*?)\\s*\\(${esc}[,)]`));
  const longName = title ? title[1].replace(/&amp;/g, "&").trim() : yahooSymbol;

  const edMatch = html.match(/"earningsDate\\":\[(.*?)\]/);
  const estMatch = html.match(/isEarningsDateEstimate\\":(true|false)/);
  const ccyMatch = html.match(/"financialCurrency\\":\\"([A-Z]+)\\"/);
  const chartAnchor = html.indexOf('"earningsChart\\":{');
  let quarterly: unknown[] = [];
  if (chartAnchor >= 0) {
    const qKey = '"quarterly\\":[';
    const qIdx = html.indexOf(qKey, chartAnchor);
    if (qIdx >= 0) {
      const raw = bracketSlice(html, qIdx + qKey.length - 1);
      if (raw) {
        try {
          const parsed = JSON.parse(unescapeStore(raw));
          if (Array.isArray(parsed)) quarterly = parsed;
        } catch {
          // malformed store slice — quarterly stays empty
        }
      }
    }
  }
  let earningsDate: unknown[] = [];
  if (edMatch) {
    try {
      const parsed = JSON.parse(`[${unescapeStore(edMatch[1])}]`);
      if (Array.isArray(parsed)) earningsDate = parsed;
    } catch {
      // fall through
    }
  }
  if (quarterly.length === 0 && earningsDate.length === 0) return null;
  return {
    price: { longName },
    earnings: { financialCurrency: ccyMatch?.[1] ?? "", earningsChart: { quarterly } },
    calendarEvents: {
      earnings: {
        earningsDate,
        isEarningsDateEstimate: estMatch ? estMatch[1] === "true" : false,
      },
    },
  };
}

function epochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function numRaw(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === "object" && typeof (v as { raw?: unknown }).raw === "number") {
    return (v as { raw: number }).raw;
  }
  if (v && typeof v === "object" && typeof (v as { raw?: unknown }).raw === "string") {
    const n = Number((v as { raw: string }).raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse a quoteSummary result. Upcoming = earningsDate within (now, +30d];
 *  recent = last quarterly actual within the past 7d; thinData when no
 *  actuals exist or the latest is over a year stale (HMM.A's 2010 row). */
export function parseEarnings(yahooSymbol: string, result: Record<string, unknown>, nowMs: number): EarningsInfo {
  const cal = ((result.calendarEvents as Record<string, unknown> | undefined)?.earnings ?? {}) as {
    earningsDate?: unknown[];
    isEarningsDateEstimate?: boolean;
  };
  const earn = (result.earnings ?? {}) as { financialCurrency?: unknown };
  const price = (result.price ?? {}) as { longName?: unknown; currency?: unknown };
  const quarterly = ((result.earnings as Record<string, unknown> | undefined)?.earningsChart as
    | { quarterly?: Record<string, unknown>[] }
    | undefined)?.quarterly ?? [];

  const upcoming: UpcomingEarning[] = [];
  for (const d of cal.earningsDate ?? []) {
    const ms = epochMs((d as { raw?: unknown })?.raw ?? d);
    if (ms == null) continue;
    if (ms > nowMs && ms <= nowMs + 30 * 86_400_000) {
      upcoming.push({
        date: new Date(ms).toISOString().slice(0, 10),
        estimated: cal.isEarningsDateEstimate ?? false,
      });
    }
  }

  let thinData = true;
  let recent: RecentResult[] = [];
  const withActual = quarterly.filter((q) => numRaw(q.actual) != null);
  if (withActual.length > 0) {
    const last = withActual[withActual.length - 1];
    // Quarterly `date` is a label ("3Q2025"); recency comes from
    // reportedDate, falling back to periodEndDate, then the label.
    const lastMs =
      epochMs((last.reportedDate as { raw?: unknown } | undefined)?.raw) ??
      epochMs((last.periodEndDate as { raw?: unknown } | undefined)?.raw) ??
      epochMs((last.date as { raw?: unknown } | undefined)?.raw ?? last.date);
    if (lastMs != null && nowMs - lastMs <= 365 * 86_400_000) thinData = false;
    if (lastMs != null && lastMs <= nowMs && nowMs - lastMs <= 7 * 86_400_000) {
      const epsA = numRaw(last.actual);
      const epsE = numRaw(last.estimate);
      const provided = numRaw((last as Record<string, unknown>).surprisePct);
      recent = [
        {
          date: new Date(lastMs).toISOString().slice(0, 10),
          epsActual: epsA,
          epsEstimate: epsE,
          surprisePct:
            provided ?? (epsA != null && epsE ? Math.round(((epsA - epsE) / Math.abs(epsE)) * 1000) / 10 : null),
          revActual: numRaw((last.revenue as Record<string, unknown> | undefined)?.actual),
          revEstimate: numRaw((last.revenue as Record<string, unknown> | undefined)?.estimate),
        },
      ];
    }
  }

  return {
    yahooSymbol,
    longName: typeof price.longName === "string" ? price.longName : yahooSymbol,
    currency: typeof earn.financialCurrency === "string" ? earn.financialCurrency : typeof price.currency === "string" ? price.currency : "",
    upcoming: upcoming.sort((a, b) => (a.date < b.date ? -1 : 1)),
    recent,
    thinData,
  };
}

export async function collectYahooEarnings(
  ctx: CollectContext,
  holdings: ResolvedHolding[],
  dataDir: string,
  base: string
): Promise<{ items: RawItem[]; throttled: boolean }> {
  const at = new Date().toISOString();
  const nowMs = Date.now();
  // Strategy per run: quoteSummary API when a crumb is available (cheap,
  // precise), quote-page HTML otherwise (verified working, ~1 MB × symbols).
  let cache = readCrumb(dataDir);
  let usePages = false;
  if (!cache) {
    try {
      cache = await freshCrumb();
      writeCrumb(dataDir, cache);
    } catch (err) {
      ctx.log(`${ID} crumb FAILED (${err instanceof Error ? err.message : err}) — falling back to quote pages`);
      usePages = true;
    }
  }
  const push = (
    out: RawItem[],
    h: ResolvedHolding,
    result: Record<string, unknown>
  ): void => {
    out.push({
      adapter: ID,
      fetchedAt: at,
      payload: {
        kind: "earnings",
        holding: { userTicker: h.userTicker, company: h.company },
        info: parseEarnings(h.yahooSymbol, result, nowMs),
      },
    });
  };
  const out: RawItem[] = [];
  if (usePages) {
    for (const h of holdings) {
      try {
        const html = await fetchText(ID, `https://finance.yahoo.com/quote/${encodeURIComponent(h.yahooSymbol)}`);
        const result = extractQuotePage(html, h.yahooSymbol);
        if (!result) {
          ctx.log(`${ID} ${h.userTicker} pages: no earnings store`);
          continue;
        }
        push(out, h, result);
      } catch (err) {
        ctx.log(`${ID} ${h.userTicker} pages FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
    ctx.log(`${ID} earnings via pages: ${out.length}/${holdings.length} symbols`);
    return { items: out, throttled: out.length === 0 };
  }
  if (!cache) return { items: out, throttled: true }; // unreachable — keeps the API path below honest
  let refreshed = false;
  for (const h of holdings) {
    const url =
      `${base}/quoteSummary/${encodeURIComponent(h.yahooSymbol)}` +
      `?modules=calendarEvents,earnings,price&crumb=${encodeURIComponent(cache.crumb)}`;
    try {
      const j = (await fetchJson(ID, url, { headers: { Cookie: cache.cookie } })) as {
        quoteSummary?: { result?: Record<string, unknown>[] };
      };
      const result = j.quoteSummary?.result?.[0];
      if (!result) continue;
      out.push({
        adapter: ID,
        fetchedAt: at,
        payload: {
          kind: "earnings",
          holding: { userTicker: h.userTicker, company: h.company },
          info: parseEarnings(h.yahooSymbol, result, nowMs),
        },
      });
    } catch (err) {
      if (!refreshed && err instanceof AdapterError && err.status === 401) {
        // Crumb died mid-run — refresh once, retry this symbol, then move on.
        refreshed = true;
        try {
          cache = await freshCrumb();
          writeCrumb(dataDir, cache);
          const retry = (await fetchJson(ID, url, { headers: { Cookie: (cache as CrumbCache).cookie } })) as {
            quoteSummary?: { result?: Record<string, unknown>[] };
          };
          const result = retry.quoteSummary?.result?.[0];
          if (result) {
            out.push({
              adapter: ID,
              fetchedAt: at,
              payload: {
                kind: "earnings",
                holding: { userTicker: h.userTicker, company: h.company },
                info: parseEarnings(h.yahooSymbol, result, nowMs),
              },
            });
          }
          continue;
        } catch {
          // fall through to per-symbol skip
        }
      }
      ctx.log(`${ID} ${h.userTicker} earnings FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  ctx.log(`${ID} earnings: ${out.length}/${holdings.length} symbols`);
  return { items: out, throttled: false };
}
