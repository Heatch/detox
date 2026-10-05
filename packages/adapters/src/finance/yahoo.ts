import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson, fetchText } from "../http.js";

// Yahoo Finance per-symbol news RSS (experiment 008): complete coverage of
// all 25 investable symbols with per-symbol attribution — press releases,
// offerings, dividends, litigation all flow through it. Batched RSS is
// lossy (no attribution), so this stays per-symbol. Promo/opinion pieces
// are cut by rules before selection.
export const ID = "holdings.yahoo";

export interface HoldingInput {
  ticker: string;
  exchange?: string;
  company?: string;
}

export interface ResolvedHolding {
  userTicker: string;
  yahooSymbol: string;
  company: string;
}

const DEFAULT_CDR_MAP: Record<string, string> = {
  "NEO:BLK": "BLK",
  "NEO:COST": "COST",
  "NEO:GOOG": "GOOG",
  "NEO:MCD": "MCD",
  "NEO:NVDA": "NVDA",
  "NEO:NVON": "NVO",
  "NEO:WMT": "WMT",
};

const DEFAULT_ETF_EXCLUDE = ["CBIL", "XEN", "NLR"];

/** Symbol resolution (experiment 008 — every trap confirmed live):
 *  NEO CDRs via explicit map (NVON→NVO, never prefix-stripped);
 *  TSX class shares dot→dash (HMM.A→HMM-A.TO); TSX→.TO; TSXV→.V;
 *  bare tickers as-is; ETFs excluded entirely. */
export function resolveHolding(
  h: HoldingInput,
  cdrMap: Record<string, string> = DEFAULT_CDR_MAP,
  etfExclude: string[] = DEFAULT_ETF_EXCLUDE
): ResolvedHolding | { excluded: "ETF" } {
  const bare = h.ticker.includes(":") ? h.ticker.split(":").slice(1).join(":") : h.ticker;
  const upper = bare.toUpperCase();
  if (etfExclude.some((x) => x.toUpperCase() === upper || x.toUpperCase() === h.ticker.toUpperCase())) {
    return { excluded: "ETF" };
  }
  if (h.exchange === "NEO") {
    return { userTicker: h.ticker, yahooSymbol: cdrMap[h.ticker] ?? bare, company: h.company ?? bare };
  }
  if (h.exchange === "TSX") {
    return { userTicker: h.ticker, yahooSymbol: `${bare.replace(/\./g, "-")}.TO`, company: h.company ?? bare };
  }
  if (h.exchange === "TSXV") {
    return { userTicker: h.ticker, yahooSymbol: `${bare}.V`, company: h.company ?? bare };
  }
  return { userTicker: h.ticker, yahooSymbol: bare, company: h.company ?? bare };
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n as string] ?? n
    )
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function domainOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const title = tag(body, "title");
    const link = tag(body, "link");
    if (!title || !link) continue;
    const source = tag(body, "source") || domainOf(link);
    out.push({ title, link, pubDate: tag(body, "pubDate"), source });
  }
  return out;
}

// Promo/opinion filter v1 (experiment 008 follow-up): domain blocklist +
// title heuristics. Conservative by design — false keeps are judged by
// selection; false cuts would hide real news.
const PROMO_DOMAINS = [
  "seekingalpha.com",
  "fool.com",
  "marketbeat.com",
  "zacks.com",
  "tipranks.com",
  "247wallst.com",
  "thestreet.com",
];

const PROMO_TITLE = [
  /should you buy/i,
  /buy now/i,
  /price target/i,
  /analyst (upgrade|downgrade|rating)/i,
  /\bbest .* to buy\b/i,
  /\btop .* stocks?\b/i,
  /^(3|5)\s+\S+\s+(stocks|reasons)/i,
  /what .* says about/i,
  /jim cramer/i,
];

export function isPromo(item: RssItem): boolean {
  const host = domainOf(item.link).toLowerCase();
  if (PROMO_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return PROMO_TITLE.some((re) => re.test(item.title));
}

export async function collectYahooNews(
  ctx: CollectContext,
  holdings: ResolvedHolding[],
  rssBase: string
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const out: RawItem[] = [];
  for (const h of holdings) {
    try {
      const url = `${rssBase}?s=${encodeURIComponent(h.yahooSymbol)}&region=US&lang=en-US`;
      const xml = await fetchText(ID, url);
      const items = parseRss(xml);
      const kept = items.filter((i) => !isPromo(i));
      ctx.log(`${ID} ${h.userTicker}: ${kept.length}/${items.length} news kept`);
      for (const item of kept) {
        out.push({
          adapter: ID,
          fetchedAt: at,
          payload: {
            kind: "news",
            holding: { userTicker: h.userTicker, company: h.company },
            yahooSymbol: h.yahooSymbol,
            item,
          },
        });
      }
    } catch (err) {
      ctx.log(`${ID} ${h.userTicker} news FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}
