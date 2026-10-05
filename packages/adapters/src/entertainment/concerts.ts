import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Ticketmaster Discovery, Toronto concerts (experiment 003): ONE city-wide
// pull (paginated, music classification), client-side date filter +
// attraction-name matching. Per-artist keyword search is a proven trap
// (keyword=Drake → 31 events, zero Drakes) — never query per artist.
export const ID = "entertainment.concerts";

export interface ConcertRow {
  id: string;
  artist: string;
  event: string;
  date: string;
  venue: string;
  url: string;
}

const TRIBUTE_WORDS = ["tribute", "cover band", "tribute band", "tribute show", "impersonator"];

function matchesArtist(attraction: string, artist: string): boolean {
  const a = attraction.toLowerCase();
  const b = artist.toLowerCase();
  if (a === b) return true;
  if (!a.includes(b)) return false;
  // "Taylor Swift Tribute" contains "Taylor Swift" — not her show.
  return !TRIBUTE_WORDS.some((w) => a.includes(w));
}

interface TmEvent {
  id?: string;
  name?: string;
  url?: string;
  dates?: { start?: { localDate?: string } };
  _embedded?: { attractions?: { name?: string }[]; venues?: { name?: string }[] };
}

export function matchConcerts(
  events: TmEvent[],
  artists: string[],
  gte: string,
  lte: string
): ConcertRow[] {
  const out: ConcertRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const date = e.dates?.start?.localDate ?? "";
    if (!date || date < gte || date > lte || e.id == null || seen.has(e.id)) continue;
    const attractions = (e._embedded?.attractions ?? []).map((a) => a.name ?? "");
    const artist = artists.find((name) => attractions.some((a) => matchesArtist(a, name)));
    if (!artist) continue;
    seen.add(e.id);
    out.push({
      id: `tm:${e.id}`,
      artist,
      event: e.name ?? artist,
      date,
      venue: e._embedded?.venues?.[0]?.name ?? "",
      url: e.url ?? "",
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function collectConcerts(
  ctx: CollectContext,
  opts: {
    apiKey: string;
    city: string;
    radiusKm: number;
    windowDays: number;
    artists: string[];
  }
): Promise<ConcertRow[]> {
  const now = new Date();
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + "Z";
  const gte = iso(now.getTime()).slice(0, 10);
  const lte = iso(now.getTime() + opts.windowDays * 86_400_000).slice(0, 10);
  const all: TmEvent[] = [];
  // TM's date sort is unreliable (past events surface) — page through the
  // city pull (bounded) and filter client-side.
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      apikey: opts.apiKey,
      city: opts.city,
      radius: String(opts.radiusKm),
      unit: "km",
      classificationName: "music",
      startDateTime: iso(now.getTime()),
      endDateTime: iso(now.getTime() + opts.windowDays * 86_400_000),
      size: "200",
      page: String(page),
      sort: "date,asc",
    });
    const res = (await fetchJson(ID, `https://app.ticketmaster.com/discovery/v2/events.json?${params}`)) as {
      _embedded?: { events?: TmEvent[] };
      page?: { totalPages?: number };
    };
    const events = res._embedded?.events ?? [];
    all.push(...events);
    ctx.log(`${ID} page ${page}: ${events.length} events`);
    if (events.length < 200 || page + 1 >= (res.page?.totalPages ?? 1)) break;
  }
  const rows = matchConcerts(all, opts.artists, gte, lte);
  ctx.log(`${ID}: ${rows.length} Toronto concerts matching ${opts.artists.length} artists`);
  return rows;
}

export function toRawItems(fetchedAt: string, rows: ConcertRow[]): RawItem[] {
  return rows.map((concert) => ({ adapter: ID, fetchedAt, payload: { kind: "concert", concert } }));
}
