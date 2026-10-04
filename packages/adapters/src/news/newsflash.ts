import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Newsflash tech lane (experiment 001): deduped event graph with
// corroboration counts and canonical summaries. One request per run.
// Cleanup: English filter (client-side over sources[].lang — no lang param
// exists), HTML-entity decoding, null-summary fallback, sort by
// confidence + recency (the API's default order is not importance).
export const ID = "news.newsflash";

interface LaneQuery {
  category?: string;
  q?: string;
  semantic?: number;
  min_sources?: number;
  window_hours?: number;
}

interface NewsflashEvent {
  id: number;
  canonical_title?: string;
  summary?: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
  source_count?: number;
  sources?: { name?: string; lang?: string }[] | string[];
  confidence?: number;
  url?: string;
  [k: string]: unknown;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n as string] ?? n
    );
}

function sourceLangs(e: NewsflashEvent): string[] {
  return (e.sources ?? [])
    .map((s) => (typeof s === "string" ? undefined : s.lang))
    .filter((l): l is string => !!l);
}

export function cleanEvent(e: NewsflashEvent): NewsflashEvent {
  const langs = sourceLangs(e);
  return {
    ...e,
    canonical_title: e.canonical_title ? decodeEntities(e.canonical_title) : e.canonical_title,
    summary: e.summary ? decodeEntities(e.summary) : e.summary,
    _langs: langs,
  } as NewsflashEvent;
}

export function englishOnly(e: NewsflashEvent, langs: string[]): boolean {
  const known = sourceLangs(e);
  if (known.length === 0) return true;
  return known.some((l) => langs.includes(l));
}

export function sortEvents(a: NewsflashEvent, b: NewsflashEvent): number {
  const conf = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (conf !== 0) return conf;
  return Date.parse(b.first_seen_at ?? "") - Date.parse(a.first_seen_at ?? "");
}

export async function collectNewsflash(
  ctx: CollectContext,
  base: string,
  apiKey: string,
  lane: string,
  query: LaneQuery,
  defaults: { relevance_floor?: number; langs?: string[]; min_sources?: number; window_hours?: number }
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const params = new URLSearchParams();
  if (query.category) params.set("category", query.category);
  if (query.q) params.set("q", query.q);
  if (query.semantic) params.set("semantic", String(query.semantic));
  params.set("min_sources", String(query.min_sources ?? defaults.min_sources ?? 2));
  // Per-lane window override: q-lanes set window_hours: 0 to OMIT `from`
  // entirely (experiment 014) — `from` collapses semantic ranking to
  // recency, while the full 30-day window ranks well and the pipeline's
  // 7-day age cap enforces freshness instead.
  const windowHours = query.window_hours ?? defaults.window_hours;
  if (windowHours) {
    params.set("from", new Date(Date.now() - windowHours * 3600_000).toISOString());
  }
  const url = `${base}/events?${params}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const res = (await fetchJson(ID, url, { minGapMs: 1000, headers: auth })) as {
    events?: NewsflashEvent[];
  };
  const events = (res.events ?? []).map(cleanEvent).filter((e) => englishOnly(e, defaults.langs ?? ["en"]));
  events.sort(sortEvents);
  ctx.log(`${ID} ${lane}: ${events.length} events`);
  return events.map((e) => ({
    adapter: ID,
    fetchedAt: at,
    payload: { lane, event: e },
  }));
}
