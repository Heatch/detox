import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";
import { FileCache } from "../cache.js";

// TMDB movies + TV (experiments 010, 011). Key via ?api_key=. Two movie
// tiers (watchlist always-shows + English/big-enough), three-part TV
// (seen→new seasons, gated new shows, rules+LLM confidence). The `taste`
// LLM call itself happens in run.ts (it needs db/budget); this adapter
// returns candidates with rules confidence attached.
export const ID = "entertainment.tmdb";

const DAY = 86_400_000;
const TV_DETAILS_TTL_MS = 24 * 3600_000;

interface Cfg {
  apiKey: string;
  base: string;
  cache: FileCache;
}

async function tmdbGet(cfg: Cfg, path: string, cacheTtlMs = 0): Promise<unknown> {
  const url = `${cfg.base}${path}${path.includes("?") ? "&" : "?"}api_key=${cfg.apiKey}`;
  if (cacheTtlMs > 0) {
    const hit = cfg.cache.get(url);
    if (hit && Date.now() - Date.parse(hit.at) < cacheTtlMs) return hit.body;
  }
  const body = await fetchJson(ID, url);
  if (cacheTtlMs > 0) cfg.cache.set(url, { body, at: new Date().toISOString() });
  return body;
}

function windowRange(days: number): { gte: string; lte: string } {
  const now = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { gte: iso(now), lte: iso(now + days * DAY) };
}

// --- people / show resolution (cached forever — names don't change) --------

export async function resolvePersonId(cfg: Cfg, name: string): Promise<number | null> {
  const cached = cfg.cache.get(`tmdb:person:${name.toLowerCase()}`);
  if (cached && typeof (cached.body as { id?: unknown }).id === "number") {
    return (cached.body as { id: number }).id;
  }
  const res = (await tmdbGet(cfg, `/search/person?query=${encodeURIComponent(name)}`)) as {
    results?: { id?: number; name?: string }[];
  };
  const first = res.results?.[0];
  if (first?.id == null) return null;
  cfg.cache.set(`tmdb:person:${name.toLowerCase()}`, { body: { id: first.id }, at: new Date().toISOString() });
  return first.id;
}

export async function resolveShowId(cfg: Cfg, title: string): Promise<number | null> {
  const cached = cfg.cache.get(`tmdb:show:${title.toLowerCase()}`);
  if (cached && typeof (cached.body as { id?: unknown }).id === "number") {
    return (cached.body as { id: number }).id;
  }
  const res = (await tmdbGet(cfg, `/search/tv?query=${encodeURIComponent(title)}`)) as {
    results?: { id?: number; name?: string }[];
  };
  const first = res.results?.[0];
  if (first?.id == null) return null;
  cfg.cache.set(`tmdb:show:${title.toLowerCase()}`, { body: { id: first.id }, at: new Date().toISOString() });
  return first.id;
}

// --- movies ----------------------------------------------------------------

export interface MovieRow {
  id: string;
  title: string;
  date: string;
  reason: string;
  tier: 1 | 2;
}

interface DiscoverMovie {
  id?: number;
  title?: string;
  release_date?: string;
  popularity?: number;
}

export function inWindow(date: string | undefined, gte: string, lte: string): boolean {
  return !!date && date >= gte && date <= lte;
}

export async function collectMovies(
  ctx: CollectContext,
  cfg: Cfg,
  opts: { people: string[]; budgetMinM: number; majorStudios: string[]; language: string; windowDays: number }
): Promise<MovieRow[]> {
  const { gte, lte } = windowRange(opts.windowDays);
  const out: MovieRow[] = [];
  const seen = new Set<number>();

  // Tier 1: watchlist, pipe-OR, no filters — always shows.
  const ids: { id: number; name: string }[] = [];
  for (const name of opts.people) {
    const id = await resolvePersonId(cfg, name);
    if (id != null) ids.push({ id, name });
  }
  if (ids.length > 0) {
    const res = (await tmdbGet(
      cfg,
      `/discover/movie?with_people=${ids.map((x) => x.id).join("|")}` +
        `&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}&sort_by=popularity.desc`
    )) as { results?: DiscoverMovie[] };
    for (const m of (res.results ?? []).slice(0, 15)) {
      if (m.id == null || seen.has(m.id)) continue;
      seen.add(m.id);
      // Name the reason: which watchlist person is actually in it.
      let who = "";
      try {
        const credits = (await tmdbGet(cfg, `/movie/${m.id}/credits`)) as {
          cast?: { name?: string }[];
          crew?: { name?: string; job?: string }[];
        };
        const names = new Set([
          ...(credits.cast ?? []).slice(0, 20).map((c) => c.name ?? ""),
          ...(credits.crew ?? []).filter((c) => /director|producer/i.test(c.job ?? "")).map((c) => c.name ?? ""),
        ]);
        who = ids.find((x) => names.has(x.name))?.name ?? "";
      } catch {
        // credits fetch failed — still show, generic reason
      }
      out.push({
        id: `tmdb:movie:${m.id}`,
        title: m.title ?? "(untitled)",
        date: m.release_date ?? "",
        reason: who ? `with ${who}` : "watchlist pick",
        tier: 1,
      });
    }
    ctx.log(`${ID} movies tier1: ${out.length} watchlist hits`);
  }

  // Tier 2: English + big enough (budget when known, else major studio).
  const res2 = (await tmdbGet(
    cfg,
    `/discover/movie?with_original_language=${opts.language}` +
      `&primary_release_date.gte=${gte}&primary_release_date.lte=${lte}&sort_by=popularity.desc&page=1`
  )) as { results?: DiscoverMovie[] };
  const studios = new Set(opts.majorStudios.map((s) => s.toLowerCase()));
  for (const m of (res2.results ?? []).slice(0, 20)) {
    if (m.id == null || seen.has(m.id)) continue;
    let det: { budget?: number; production_companies?: { name?: string }[] };
    try {
      det = (await tmdbGet(cfg, `/movie/${m.id}`)) as typeof det;
    } catch {
      continue;
    }
    const budgetM = (det.budget ?? 0) / 1_000_000;
    const companies = (det.production_companies ?? []).map((c) => c.name ?? "");
    const studio = companies.find((c) => studios.has(c.toLowerCase()));
    if (budgetM >= opts.budgetMinM) {
      seen.add(m.id);
      out.push({ id: `tmdb:movie:${m.id}`, title: m.title ?? "(untitled)", date: m.release_date ?? "", reason: `$${Math.round(budgetM)}M budget`, tier: 2 });
    } else if (studio) {
      seen.add(m.id);
      out.push({ id: `tmdb:movie:${m.id}`, title: m.title ?? "(untitled)", date: m.release_date ?? "", reason: studio, tier: 2 });
    }
  }
  ctx.log(`${ID} movies tier2 done: ${out.length} total movies`);
  return out;
}

// --- TV --------------------------------------------------------------------

export interface TvSeasonRow {
  id: string;
  title: string;
  date: string;
  reason: string;
}

interface TvSeason {
  season_number?: number;
  episode_count?: number;
  air_date?: string | null;
}

export interface TvDetails {
  id: number;
  name: string;
  status: string;
  seasons: TvSeason[];
  next_episode_to_air: { air_date?: string; episode_number?: number } | null;
  genres: string[];
  networks: string[];
  creators: string[];
}

/** New-season signal from the seasons[] tail (experiment 011): next_episode
 *  is empty for most returning shows, so seasons[] is the signal. Returns
 *  null when nothing new is coming. */
export function newSeasonSignal(title: string, d: TvDetails): TvSeasonRow | null {
  const numbered = (d.seasons ?? []).filter((s) => (s.season_number ?? 0) > 0);
  if (numbered.length === 0) return null;
  const tail = numbered[numbered.length - 1];
  const n = tail.season_number ?? 0;
  const id = `tmdb:tv:${d.id}:s${n}`;
  if (tail.air_date) {
    if (Date.parse(tail.air_date) > Date.now()) {
      return { id, title, date: tail.air_date, reason: `Season ${n} starts ${tail.air_date}` };
    }
    return null;
  }
  if (d.status === "Returning Series") {
    return { id, title, date: "", reason: `Season ${n} announced, no date yet` };
  }
  return null;
}

export async function fetchShowDetails(cfg: Cfg, showId: number): Promise<TvDetails | null> {
  const d = (await tmdbGet(cfg, `/tv/${showId}`, TV_DETAILS_TTL_MS)) as {
    id?: number;
    name?: string;
    status?: string;
    seasons?: TvSeason[];
    next_episode_to_air?: TvDetails["next_episode_to_air"];
    genres?: { name?: string }[];
    networks?: { name?: string }[];
    created_by?: { name?: string }[];
  };
  if (d.id == null) return null;
  return {
    id: d.id,
    name: d.name ?? "",
    status: d.status ?? "",
    seasons: d.seasons ?? [],
    next_episode_to_air: d.next_episode_to_air ?? null,
    genres: (d.genres ?? []).map((g) => g.name ?? "").filter(Boolean),
    networks: (d.networks ?? []).map((n) => n.name ?? "").filter(Boolean),
    creators: (d.created_by ?? []).map((c) => c.name ?? "").filter(Boolean),
  };
}

export interface TvCandidate {
  id: string;
  title: string;
  date: string;
  popularity: number;
  overview: string;
  genres: string[];
  rulesConfidence: number;
  rulesReason: string;
}

export interface TasteProfileData {
  genres: Map<string, number>;
  creators: Set<string>;
  networks: Set<string>;
  lovedTitles: string[];
}

export function buildTasteProfileData(seen: { title: string; details: TvDetails | null }[]): TasteProfileData {
  const genres = new Map<string, number>();
  const creators = new Set<string>();
  const networks = new Set<string>();
  const lovedTitles: string[] = [];
  for (const s of seen) {
    lovedTitles.push(s.title);
    if (!s.details) continue;
    for (const g of s.details.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
    for (const c of s.details.creators) creators.add(c);
    for (const n of s.details.networks) networks.add(n);
  }
  return { genres, creators, networks, lovedTitles };
}

/** Rules confidence: genre-histogram overlap + creator/network overlap.
 *  Always computed, degrades gracefully (empty profile → 0.5 baseline). */
export function rulesConfidence(
  profile: TasteProfileData,
  candidate: { genres: string[]; creators?: string[]; networks?: string[] }
): { confidence: number; reason: string } {
  const total = [...profile.genres.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { confidence: 0.5, reason: "no taste profile yet" };
  let score = 0;
  const hits: string[] = [];
  for (const g of candidate.genres ?? []) {
    const w = profile.genres.get(g) ?? 0;
    if (w > 0) {
      score += w / total;
      if (hits.length < 2) hits.push(g);
    }
  }
  const parts: string[] = [...hits];
  for (const c of candidate.creators ?? []) {
    if (profile.creators.has(c)) {
      score += 0.25;
      parts.push(`by ${c}`);
      break;
    }
  }
  for (const n of candidate.networks ?? []) {
    if (profile.networks.has(n)) {
      score += 0.15;
      parts.push(`on ${n}`);
      break;
    }
  }
  return {
    confidence: Math.min(0.95, Math.round(score * 100) / 100),
    reason: parts.length > 0 ? `matches your ${parts.slice(0, 2).join(", ")} shows` : "little overlap with watched shows",
  };
}

const TV_GENRES: Record<number, string> = {
  10759: "Action & Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 10762: "Kids", 9648: "Mystery", 10763: "News",
  10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk",
  10768: "War & Politics", 37: "Western",
};

export async function collectTv(
  ctx: CollectContext,
  cfg: Cfg,
  opts: {
    seenShows: string[];
    popularityMin: number;
    confidenceMin: number;
    language: string;
    windowDays: number;
  }
): Promise<{ seasons: TvSeasonRow[]; candidates: TvCandidate[]; profile: TasteProfileData; seenGenres: { title: string; genres: string[] }[] }> {
  const seasons: TvSeasonRow[] = [];
  const seen: { title: string; details: TvDetails | null }[] = [];
  for (const title of opts.seenShows) {
    const id = await resolveShowId(cfg, title);
    if (id == null) {
      ctx.log(`${ID} tv: could not resolve "${title}"`);
      seen.push({ title, details: null });
      continue;
    }
    let details: TvDetails | null = null;
    try {
      details = await fetchShowDetails(cfg, id);
    } catch (err) {
      ctx.log(`${ID} tv "${title}" details FAILED: ${err instanceof Error ? err.message : err}`);
    }
    seen.push({ title, details });
    if (details) {
      const sig = newSeasonSignal(title, details);
      if (sig) seasons.push(sig);
    }
  }
  ctx.log(`${ID} tv: ${seasons.length} new seasons from ${seen.length} seen shows`);

  const profile = buildTasteProfileData(seen);
  const now = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const res = (await tmdbGet(
    cfg,
    `/discover/tv?first_air_date.gte=${iso(now - 7 * DAY)}&first_air_date.lte=${iso(now + opts.windowDays * DAY)}` +
      `&with_original_language=${opts.language}&sort_by=popularity.desc`
  )) as {
    results?: { id?: number; name?: string; first_air_date?: string; popularity?: number; overview?: string; genre_ids?: number[] }[];
  };
  const seenIds = new Set(seen.map((s) => s.details?.id).filter((x): x is number => x != null));
  const candidates: TvCandidate[] = [];
  for (const c of (res.results ?? []).slice(0, 30)) {
    if (c.id == null || seenIds.has(c.id)) continue;
    const genres = (c.genre_ids ?? []).map((g) => TV_GENRES[g] ?? "").filter(Boolean);
    // Creator/network overlap needs full details — skip for discover
    // candidates (genres carry the rules score; the LLM adds judgment).
    const rc = rulesConfidence(profile, { genres });
    const pop = c.popularity ?? 0;
    if (pop >= opts.popularityMin || rc.confidence >= opts.confidenceMin) {
      candidates.push({
        id: `tmdb:tv:${c.id}`,
        title: c.name ?? "(untitled)",
        date: c.first_air_date ?? "",
        popularity: Math.round(pop * 10) / 10,
        overview: c.overview ?? "",
        genres,
        rulesConfidence: rc.confidence,
        rulesReason: rc.reason,
      });
    }
  }
  ctx.log(`${ID} tv: ${candidates.length} gated new-show candidates`);
  return {
    seasons,
    candidates,
    profile,
    seenGenres: seen.map((s) => ({ title: s.title, genres: s.details?.genres ?? [] })),
  };
}

export function toRawItems(
  fetchedAt: string,
  movies: MovieRow[],
  seasons: TvSeasonRow[],
  candidates: TvCandidate[],
  seenGenres: { title: string; genres: string[] }[]
): RawItem[] {
  const out: RawItem[] = [];
  for (const m of movies) {
    out.push({ adapter: ID, fetchedAt, payload: { kind: "movie", movie: m } });
  }
  for (const s of seasons) {
    out.push({ adapter: ID, fetchedAt, payload: { kind: "tv-season", season: s } });
  }
  for (const c of candidates) {
    out.push({ adapter: ID, fetchedAt, payload: { kind: "tv-candidate", candidate: c } });
  }
  out.push({ adapter: ID, fetchedAt, payload: { kind: "tv-profile", seenGenres } });
  return out;
}
