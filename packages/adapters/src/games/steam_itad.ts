import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";
import { FileCache } from "../cache.js";

// Steam wishlist + ITAD sale prices (experiment 012): universal-lowest
// price wins (never shop-assumed), deals=true means only actual discounts.
// ITAD unreachable/unkeyed → Steam-store discounts only, lane says so.
export const ID = "entertainment.games";

export interface GameRow {
  id: string;
  appid: number;
  name: string;
  oldPrice: string;
  newPrice: string;
  pctOff: number;
  shop: string;
  historyLow: string;
  newLow: boolean;
  url: string;
  priority: number;
}

function money(cents: number | undefined, currency: string): string {
  if (cents == null) return "";
  const sym = currency === "CAD" ? "CDN$ " : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

const ITAD = "https://api.isthereanydeal.com";

async function itadPost(path: string, key: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${ITAD}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ITAD-API-Key": key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ITAD ${path} HTTP ${r.status}`);
  return r.json() as unknown;
}

export async function resolveVanity(cache: FileCache, username: string): Promise<string> {
  const key = `steam:vanity:${username.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && typeof (hit.body as { steamid?: unknown }).steamid === "string") {
    return (hit.body as { steamid: string }).steamid;
  }
  const r = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(username)}?xml=1`);
  if (!r.ok) throw new Error(`vanity resolve HTTP ${r.status}`);
  const xml = await r.text();
  const m = xml.match(/<steamID64>(\d+)<\/steamID64>/);
  if (!m) throw new Error(`no steamID64 for ${username}`);
  cache.set(key, { body: { steamid: m[1] }, at: new Date().toISOString() });
  return m[1];
}

interface WishlistEntry {
  appid: number;
  priority: number;
}

interface SteamDeal {
  name: string;
  oldPrice: string;
  newPrice: string;
  pctOff: number;
}

async function steamPrice(appid: number, country: string): Promise<{ name: string; deal: SteamDeal | null; url: string } | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${country.toLowerCase()}&l=en`;
  const j = (await fetchJson(ID, url)) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
  const d = j[String(appid)]?.data;
  if (!d || j[String(appid)]?.success === false) return null;
  const po = d.price_overview as
    | { currency?: string; initial?: number; final?: number; discount_percent?: number }
    | undefined;
  const name = typeof d.name === "string" ? d.name : `App ${appid}`;
  const storeUrl = `https://store.steampowered.com/app/${appid}/`;
  if (!po || (po.discount_percent ?? 0) <= 0) {
    return { name, deal: null, url: storeUrl };
  }
  return {
    name,
    deal: {
      name,
      oldPrice: money(po.initial, po.currency ?? ""),
      newPrice: money(po.final, po.currency ?? ""),
      pctOff: po.discount_percent ?? 0,
    },
    url: storeUrl,
  };
}

interface ItadDeal {
  price?: { amount?: number; currency?: string };
  regular?: { amount?: number };
  cut?: number;
  shop?: { name?: string };
  url?: string;
  expiry?: string;
}

/** Universal lowest across all covered shops — never shop-assumed. */
export function bestDeal(deals: ItadDeal[], currency: string): (SteamDeal & { shop: string; url: string; amount: number }) | null {
  let best: ItadDeal | null = null;
  for (const d of deals) {
    if (typeof d.price?.amount !== "number") continue;
    if (!best || (d.price.amount as number) < (best.price?.amount ?? Infinity)) best = d;
  }
  if (!best || typeof best.price?.amount !== "number") return null;
  return {
    name: "",
    oldPrice: money(best.regular?.amount, currency),
    newPrice: money(best.price.amount, currency),
    pctOff: best.cut ?? 0,
    shop: best.shop?.name ?? "",
    url: best.url ?? "",
    amount: best.price.amount,
  };
}

export async function collectGames(
  ctx: CollectContext,
  cache: FileCache,
  opts: { username: string; country: string; currency: string; itadKey: string }
): Promise<{ rows: GameRow[]; itadOk: boolean }> {
  const steamid = await resolveVanity(cache, opts.username);
  const wl = (await fetchJson(
    ID,
    `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamid}`
  )) as { response?: { items?: { appid?: number; priority?: number }[] } };
  const entries: WishlistEntry[] = (wl.response?.items ?? [])
    .filter((i) => typeof i.appid === "number")
    .map((i) => ({ appid: i.appid as number, priority: i.priority ?? 99 }))
    .sort((a, b) => a.priority - b.priority);
  ctx.log(`${ID} wishlist: ${entries.length} games`);

  // ITAD UUID mapping (keyless) + prices (keyed). deals=true omits
  // deal-less games from the response — union against the wishlist.
  let uuidByApp = new Map<string, string>();
  let prices: Record<string, { deals?: ItadDeal[]; historyLow?: { all?: { amount?: number; currency?: string } } }> = {};
  let itadOk = false;
  if (opts.itadKey) {
    try {
      const lookup = (await itadPost(
        "/lookup/id/shop/61/v1",
        opts.itadKey,
        entries.map((e) => `app/${e.appid}`)
      )) as Record<string, string>;
      uuidByApp = new Map(Object.entries(lookup));
      const uuids = [...uuidByApp.values()];
      if (uuids.length > 0) {
        const url =
          `${ITAD}/games/prices/v3?key=${encodeURIComponent(opts.itadKey)}` +
          `&country=${opts.country}&currency=${opts.currency}&deals=true&capacity=5`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(uuids),
        });
        if (!r.ok) throw new Error(`prices/v3 HTTP ${r.status}`);
        prices = (await r.json()) as typeof prices;
      }
      itadOk = true;
    } catch (err) {
      ctx.log(`${ID} ITAD FAILED (${err instanceof Error ? err.message : err}) — Steam-only fallback`);
    }
  } else {
    ctx.log(`${ID} no ITAD key — Steam-only fallback`);
  }
  const uuidByAppid = new Map<number, string>();
  for (const [app, uuid] of uuidByApp) {
    const m = app.match(/^app\/(\d+)$/);
    if (m) uuidByAppid.set(Number(m[1]), uuid);
  }

  const rows: GameRow[] = [];
  for (const e of entries) {
    const steam = await steamPrice(e.appid, opts.country);
    if (!steam) continue;
    const uuid = uuidByAppid.get(e.appid);
    const entry = uuid ? prices[uuid] : undefined;
    const deals = entry?.deals ?? [];
    if (deals.length > 0) {
      const best = bestDeal(deals, opts.currency);
      if (!best) continue;
      const hl = entry?.historyLow?.all;
      const hlStr = hl && typeof hl.amount === "number" ? money(hl.amount, hl.currency ?? opts.currency) : "";
      rows.push({
        id: `steam:${e.appid}`,
        appid: e.appid,
        name: steam.name,
        oldPrice: best.oldPrice,
        newPrice: best.newPrice,
        pctOff: best.pctOff,
        shop: best.shop,
        historyLow: hlStr,
        newLow: typeof hl?.amount === "number" && best.amount < hl.amount,
        url: best.url || steam.url,
        priority: e.priority,
      });
    } else if (steam.deal) {
      // No ITAD deal (or ITAD down): Steam-store discount, labeled as such.
      rows.push({
        id: `steam:${e.appid}`,
        appid: e.appid,
        name: steam.name,
        oldPrice: steam.deal.oldPrice,
        newPrice: steam.deal.newPrice,
        pctOff: steam.deal.pctOff,
        shop: "Steam",
        historyLow: "",
        newLow: false,
        url: steam.url,
        priority: e.priority,
      });
    }
    // else: not discounted anywhere → omitted (deals-only lane)
  }
  // Rank by deepest cut, then wishlist priority (experiment 012).
  rows.sort((a, b) => b.pctOff - a.pctOff || a.priority - b.priority);
  ctx.log(`${ID}: ${rows.length} discounted games (ITAD ${itadOk ? "ok" : "fallback"})`);
  return { rows, itadOk };
}

export function toRawItems(
  fetchedAt: string,
  rows: GameRow[],
  itadOk: boolean
): RawItem[] {
  const out: RawItem[] = rows.map((game) => ({ adapter: ID, fetchedAt, payload: { kind: "game", game } }));
  out.push({ adapter: ID, fetchedAt, payload: { kind: "games-summary", itadOk, total: rows.length } });
  return out;
}
