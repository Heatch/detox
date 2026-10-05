import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectContext, RawItem } from "@detox/core";
import { AdapterError, fetchJson } from "../http.js";
import { FileCache } from "../cache.js";

// Music: Spotify supplies the artist SET only; MusicBrainz release-level
// queries are the calendar (experiment 004). No catalog scanning (which
// also removes the rate-limit exposure), no Newsflash for music.
export const ID = "entertainment.music";

export interface MusicRelease {
  id: string;
  artist: string;
  title: string;
  date: string;
  precision: "day" | "month" | "year";
  kind: string;
}

const TOKEN_FILE = "spotify_tokens.json";
const ARTIST_CACHE_FILE = ["cache", "spotify-artists.json"].join("/");

interface SpotifyTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

// In-process memo: the pipeline collects music + concerts concurrently, and
// a token refresh rotates the refresh token — two simultaneous refreshes
// would leave one caller holding dead tokens. Memoized per UTC day; failures
// clear the memo so the next caller retries.
let artistMemo: { day: string; promise: Promise<string[]> } | null = null;

/** Top-artist names, refreshing the stored tokens when expired. Writes the
 *  blended set to data/cache for the concerts adapter (race-free: the
 *  concerts side only ever reads it). */
export async function getSpotifyArtists(
  ctx: CollectContext,
  dataDir: string,
  clientId: string,
  opts: { topN: number; timeRange: string; manual: string[] }
): Promise<string[]> {
  const day = new Date().toISOString().slice(0, 10);
  if (!artistMemo || artistMemo.day !== day) {
    artistMemo = { day, promise: fetchSpotifyArtists(ctx, dataDir, clientId, opts) };
    artistMemo.promise.catch(() => {
      artistMemo = null;
    });
  }
  return artistMemo.promise;
}

async function fetchSpotifyArtists(
  ctx: CollectContext,
  dataDir: string,
  clientId: string,
  opts: { topN: number; timeRange: string; manual: string[] }
): Promise<string[]> {
  const path = join(dataDir, TOKEN_FILE);
  if (!existsSync(path)) throw new Error(`no ${TOKEN_FILE} — run scripts/spotify_auth.py first`);
  const tokens = JSON.parse(readFileSync(path, "utf8")) as SpotifyTokens;
  if (!tokens.access_token) throw new Error(`${TOKEN_FILE} has no access_token`);
  let access = tokens.access_token;
  if ((tokens.expires_at ?? 0) < Date.now() / 1000 + 60) {
    if (!tokens.refresh_token) throw new Error("Spotify access expired and no refresh_token stored");
    ctx.log(`${ID} refreshing Spotify access token`);
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
    });
    if (!r.ok) throw new Error(`Spotify refresh HTTP ${r.status}`);
    const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t.access_token) throw new Error("Spotify refresh returned no access_token");
    tokens.access_token = t.access_token;
    if (t.refresh_token) tokens.refresh_token = t.refresh_token;
    tokens.expires_at = Date.now() / 1000 + (t.expires_in ?? 3600) - 60;
    writeFileSync(path, JSON.stringify(tokens, null, 2));
    access = tokens.access_token;
  }
  const top = (await fetchJson(
    ID,
    `https://api.spotify.com/v1/me/top/artists?time_range=${opts.timeRange}&limit=${opts.topN}`,
    { headers: { Authorization: `Bearer ${access}` } }
  )) as { items?: { name?: string }[] };
  const names = (top.items ?? []).map((a) => a.name ?? "").filter(Boolean);
  const blended = [...names];
  for (const m of opts.manual) {
    if (m && !blended.some((b) => b.toLowerCase() === m.toLowerCase())) blended.push(m);
  }
  ctx.log(`${ID} artist set: ${names.length} Spotify + ${blended.length - names.length} manual`);
  mkdirSync(join(dataDir, "cache"), { recursive: true });
  writeFileSync(join(dataDir, ARTIST_CACHE_FILE), JSON.stringify({ at: new Date().toISOString(), artists: blended }));
  return blended;
}

export function readArtistCache(dataDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, ARTIST_CACHE_FILE), "utf8")) as { artists?: unknown };
    return Array.isArray(j.artists) ? j.artists.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

const TRIBUTE = /tribute|cover/i;

/** Artist → MBID with exact-name match and tribute rejection (exp 004).
 *  Ambiguous ties (two Tylas) take the top score and log it. MusicBrainz
 *  throttles bursts with 403s — retry once after 30 s, then give up until
 *  the next run (resolves cache forever, so this only bites the first fill). */
export async function resolveArtistMbid(
  ctx: CollectContext,
  cache: FileCache,
  name: string
): Promise<string | null> {
  const key = `mb:artist:${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && typeof (hit.body as { mbid?: unknown }).mbid === "string") {
    return (hit.body as { mbid: string }).mbid;
  }
  const query = async () =>
    (await fetchJson(
      ID,
      `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`,
      { minGapMs: 2000 }
    )) as {
      artists?: { id?: string; name?: string; disambiguation?: string; score?: number }[];
    };
  let res;
  try {
    res = await query();
  } catch (err) {
    if (!(err instanceof AdapterError) || err.status !== 403) throw err;
    ctx.log(`${ID} resolve "${name}" throttled (403) — waiting 30 s once`);
    await new Promise((r) => setTimeout(r, 30_000));
    res = await query();
  }
  const exact = (res.artists ?? []).filter((a) => a.name?.toLowerCase() === name.toLowerCase());
  const clean = exact.filter((a) => !TRIBUTE.test(a.disambiguation ?? ""));
  const pick = (clean.length > 0 ? clean : exact)[0];
  if (!pick?.id) {
    ctx.log(`${ID} could not resolve artist "${name}"`);
    return null;
  }
  if (exact.length > 1) ctx.log(`${ID} ambiguous artist "${name}" — taking ${pick.name} (${pick.disambiguation ?? "no disambiguation"})`);
  cache.set(key, { body: { mbid: pick.id }, at: new Date().toISOString() });
  return pick.id;
}

export function releaseKind(primary: string, secondary: string[], title: string): string {
  if (/super deluxe|anniversary|expanded/i.test(title)) return "reissue";
  if (/deluxe|encore/i.test(title)) return "deluxe";
  if (secondary.map((s) => s.toLowerCase()).includes("soundtrack")) return "soundtrack";
  if (secondary.map((s) => s.toLowerCase()).includes("compilation")) return "compilation";
  if (primary.toLowerCase() === "ep") return "ep";
  return primary.toLowerCase() || "release";
}

interface MbRelease {
  id?: string;
  title?: string;
  date?: string;
  status?: string;
  "release-group"?: { id?: string; "primary-type"?: { name?: string }; "secondary-types"?: { name?: string }[] };
}

export async function collectReleases(
  ctx: CollectContext,
  cache: FileCache,
  artists: { name: string; mbid: string }[],
  from: string,
  to: string,
  showReissues: boolean
): Promise<MusicRelease[]> {
  const out: MusicRelease[] = [];
  const seen = new Set<string>();
  for (const a of artists) {
    const q = encodeURIComponent(`arid:${a.mbid} AND date:[${from} TO ${to}]`);
    let releases: MbRelease[] = [];
    try {
      const res = (await fetchJson(ID, `https://musicbrainz.org/ws/2/release?query=${q}&fmt=json&limit=100`, {
        minGapMs: 2000,
      })) as { releases?: MbRelease[] };
      releases = res.releases ?? [];
    } catch (err) {
      ctx.log(`${ID} releases for ${a.name} FAILED: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    let kept = 0;
    for (const r of releases) {
      if ((r.status ?? "").toLowerCase() !== "official") continue;
      const rg = r["release-group"]?.id ?? r.id ?? "";
      const date = r.date ?? "";
      const key = `${rg}|${date}`;
      if (!rg || seen.has(key)) continue;
      seen.add(key);
      const primary = r["release-group"]?.["primary-type"]?.name ?? "";
      const secondary = (r["release-group"]?.["secondary-types"] ?? []).map((t) => t.name ?? "");
      const kind = releaseKind(primary, secondary, r.title ?? "");
      if (!showReissues && (kind === "reissue" || kind === "compilation")) continue;
      const precision = date.length >= 10 ? "day" : date.length >= 7 ? "month" : "year";
      out.push({
        id: `mb:${rg}:${date}`,
        artist: a.name,
        title: r.title ?? "(untitled)",
        date,
        precision: precision as MusicRelease["precision"],
        kind,
      });
      kept++;
    }
    ctx.log(`${ID} ${a.name}: ${kept} releases`);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function toRawItems(
  fetchedAt: string,
  artists: string[],
  releases: MusicRelease[]
): RawItem[] {
  const out: RawItem[] = artists.map((name) => ({ adapter: ID, fetchedAt, payload: { kind: "artist", name } }));
  for (const release of releases) {
    out.push({ adapter: ID, fetchedAt, payload: { kind: "release", release } });
  }
  return out;
}
