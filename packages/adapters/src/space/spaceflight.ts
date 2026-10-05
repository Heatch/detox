import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Spaceflight News API (experiment 007): articles newest-first, summary
// doubles as the one-liner (rules-only, like the Newsflash lanes). Outlet
// filtering is client-side over news_site; optional free-text `search`
// terms each cost one extra request.
export const ID = "spaceflight.news";

interface Article {
  id?: number;
  title?: string;
  url?: string;
  news_site?: string;
  summary?: string;
  published_at?: string;
}

export async function collectSpaceflightNews(
  ctx: CollectContext,
  base: string,
  opts: { newsSites: string[]; search: string[]; topN: number }
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const seen = new Set<number>();
  const out: RawItem[] = [];
  const queries = opts.search.length > 0 ? opts.search : [""];
  for (const q of queries) {
    const params = new URLSearchParams({ limit: String(opts.topN), ordering: "-published_at" });
    if (q) params.set("search", q);
    const res = (await fetchJson(ID, `${base}/articles/?${params}`)) as { results?: Article[] };
    for (const a of res.results ?? []) {
      if (a.id == null || seen.has(a.id)) continue;
      seen.add(a.id);
      if (opts.newsSites.length > 0 && a.news_site && !opts.newsSites.includes(a.news_site)) continue;
      out.push({ adapter: ID, fetchedAt: at, payload: { article: a } });
    }
    ctx.log(`${ID} ${q || "latest"}: ${out.length} articles so far`);
  }
  return out;
}
