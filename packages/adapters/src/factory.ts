import type { CollectContext, RawItem, SourceAdapter, LaneId } from "@detox/core";
import type { LoadedConfig } from "@detox/core";
import { collectEnvcan } from "./weather/envcan.js";
import { collectOpenMeteo } from "./weather/openmeteo.js";
import { collectMetno } from "./weather/metno.js";
import { collectReddit } from "./reddit/reddit.js";
import { collectNewsflash } from "./news/newsflash.js";
import { collectEspn } from "./sports/espn.js";
import { collectSpaceflightNews } from "./space/spaceflight.js";
import { collectLaunches } from "./space/launches.js";
import { collectYahooNews, resolveHolding } from "./finance/yahoo.js";
import { collectYahooEarnings } from "./finance/earnings.js";
import { collectMovies, collectTv, toRawItems } from "./entertainment/tmdb.js";
import { collectConcerts, toRawItems as concertRawItems } from "./entertainment/concerts.js";
import { collectGames, toRawItems as gamesRawItems } from "./games/steam_itad.js";
import { collectReleases, getSpotifyArtists, readArtistCache, resolveArtistMbid, toRawItems as musicRawItems } from "./entertainment/music.js";
import { FileCache } from "./cache.js";

function weatherAdapter(
  id: string,
  collect: (ctx: CollectContext) => Promise<RawItem[]>
): SourceAdapter {
  return { id, lanes: ["weather"] as LaneId[], collect };
}

// createAdapters: reads sources.yaml + interests.yaml, returns real adapters.
// Secrets come from core's .env loader via config.env — nothing else reads them.
export function createAdapters(config: LoadedConfig, dataDir: string): SourceAdapter[] {
  const { interests, sources, env } = config;
  const out: SourceAdapter[] = [];
  const locations = interests.weather.locations;

  out.push(
    weatherAdapter("weather.envcan", (ctx) => collectEnvcan(ctx, locations)),
    weatherAdapter("weather.openmeteo", (ctx) => collectOpenMeteo(ctx, locations)),
    weatherAdapter("weather.metno", (ctx) => collectMetno(ctx, locations))
  );

  const redditKey = sources.reddit?.key_env ? env[sources.reddit.key_env] : env.REDDIT_CLIENT_ID;
  out.push({
    id: "reddit.listings",
    lanes: interests.reddit.subreddits.map((s) => `reddit-${s}`) as LaneId[],
    collect: (ctx) =>
      collectReddit(
        ctx,
        {
          subreddits: interests.reddit.subreddits,
          top_n: interests.reddit.top_n,
          top_comments_n: interests.reddit.top_comments_n,
          time_window: interests.reddit.time_window,
          exclude_title_patterns: interests.reddit.exclude_title_patterns,
        },
        { clientId: redditKey ?? "", clientSecret: env.REDDIT_CLIENT_SECRET ?? "" },
        dataDir
      ),
  });

  const nf = sources.newsflash;
  const nfKey = nf?.key_env ? env[nf.key_env] : env.NEWSFLASH_API_KEY;
  // One adapter, one lane query per sources.yaml entry (§9.6). Spaceflight is
  // deliberately NOT here — its own sources (experiment 007, Phase 3B).
  const nfLaneEntries = Object.entries(nf?.lanes ?? { tech: { category: "tech", min_sources: 2 } });
  const nfLaneIds = nfLaneEntries.map(([lane]) => lane).filter((lane) => lane !== "spaceflight");
  out.push({
    id: "news.newsflash",
    lanes: nfLaneIds as LaneId[],
    collect: async (ctx) => {
      const all: RawItem[] = [];
      for (const [lane, query] of nfLaneEntries) {
        if (lane === "spaceflight") continue;
        all.push(
          ...(await collectNewsflash(
            ctx,
            nf?.base ?? "https://newsflash.sh/api",
            nfKey ?? "",
            lane,
            query as { category?: string; q?: string; semantic?: number; min_sources?: number; window_hours?: number },
            {
              relevance_floor: nf?.defaults?.relevance_floor,
              langs: nf?.defaults?.langs,
              min_sources: nf?.defaults?.min_sources,
              window_hours: nf?.defaults?.window_hours,
            }
          ))
        );
      }
      return all;
    },
  });

  const enabledTeams = (interests.sports?.teams ?? []).filter((t) => t.enabled);
  if (enabledTeams.length > 0) {
    const sportsBase = sources.sports?.base ?? "https://site.api.espn.com/apis/site/v2/sports";
    const upcomingGames =
      interests.sports?.upcoming_games ?? sources.sports?.upcoming_games ?? 5;
    out.push({
      id: "sports.espn",
      lanes: ["sports"] as LaneId[],
      collect: (ctx) => collectEspn(ctx, enabledTeams, sportsBase, upcomingGames),
    });
  }

  const sfInterests = interests.spaceflight;
  const sfSources = sources.spaceflight;
  out.push({
    id: "spaceflight.news",
    lanes: ["spaceflight"] as LaneId[],
    collect: (ctx) =>
      collectSpaceflightNews(ctx, sfSources?.news?.base ?? "https://api.spaceflightnewsapi.net/v4", {
        newsSites: sfInterests?.news_sites ?? [],
        search: sfInterests?.search ?? [],
        topN: sfInterests?.top_n ?? 25,
      }),
  });

  out.push({
    id: "space.launches",
    lanes: ["launches"] as LaneId[],
    collect: (ctx) =>
      collectLaunches(
        ctx,
        sfSources?.launches?.base ?? "https://ll.thespacedevs.com/2.2.0",
        sfSources?.launches?.limit ?? sfInterests?.launches_limit ?? 5
      ),
  });

  // Holdings (experiment 008): Yahoo single source. ETFs excluded at resolve
  // time — no news or earnings fetched. News + earnings share one adapter id;
  // payload.kind separates them downstream.
  {
    const hy = sources.holdings as
      | {
          news?: { endpoint?: string };
          earnings?: { endpoint?: string };
          cdr_map?: Record<string, string>;
        }
      | undefined;
    const rssBase =
      hy?.news?.endpoint?.split("?")[0] ?? "https://feeds.finance.yahoo.com/rss/2.0/headline";
    const earningsBase =
      hy?.earnings?.endpoint?.split("/quoteSummary/")[0] ?? "https://query1.finance.yahoo.com/v10/finance";
    out.push({
      id: "holdings.yahoo",
      lanes: ["holdings"] as LaneId[],
      collect: async (ctx) => {
        const resolved = config.holdings
          .map((h) => {
            const r = resolveHolding(h, hy?.cdr_map as Record<string, string> | undefined, undefined);
            return "excluded" in r ? null : { ...r, exchange: h.exchange };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        ctx.log(`holdings.yahoo ${resolved.length}/${config.holdings.length} holdings kept (ETFs excluded)`);
        const news = await collectYahooNews(ctx, resolved, rssBase);
        const earnings = await collectYahooEarnings(ctx, resolved, dataDir, earningsBase);
        const all = [...news, ...earnings.items];
        if (earnings.throttled) {
          all.push({ adapter: "holdings.yahoo", fetchedAt: new Date().toISOString(), payload: { kind: "earnings-status", throttled: true } });
        }
        return all;
      },
    });
  }

  // Entertainment screen (experiments 010, 011): TMDB movies + TV. One
  // adapter, lanes ["releases"]; payload.kind separates movies, new
  // seasons, and gated new-show candidates (the taste LLM call happens in
  // run.ts, which owns db/budget).
  {
    const ent = sources.entertainment_screen as
      | { base?: string; key_env?: string; movies?: Record<string, unknown> }
      | undefined;
    const tmdbKey = ent?.key_env ? env[ent.key_env] : env.TMDB_API_KEY;
    // No key → no adapter → the releases lane keeps its stub. Logged by absence.
    if (tmdbKey) {
      const cache = new FileCache(dataDir);
      const cfg = { apiKey: tmdbKey, base: ent?.base ?? "https://api.themoviedb.org/3", cache };
      out.push({
        id: "entertainment.tmdb",
        lanes: ["releases"] as LaneId[],
        collect: async (ctx) => {
          const at = new Date().toISOString();
          const movies = await collectMovies(ctx, cfg, {
            people: interests.movies?.people ?? [],
            budgetMinM: interests.movies?.budget_min_m ?? 20,
            majorStudios: interests.movies?.major_studios ?? [],
            language: interests.movies?.language ?? "en",
            windowDays: interests.movies?.window_days ?? 60,
          });
          const tv = await collectTv(ctx, cfg, {
            seenShows: interests.tv?.seen_shows ?? [],
            popularityMin: interests.tv?.new_shows?.popularity_min ?? 15,
            confidenceMin: interests.tv?.new_shows?.confidence_min ?? 0.75,
            language: interests.tv?.language ?? "en",
            windowDays: interests.tv?.window_days ?? 60,
          });
          return toRawItems(at, movies, tv.seasons, tv.candidates, tv.seenGenres);
        },
      });
    }
  }

  // Concerts (experiment 003): city-wide pull + attraction matching against
  // the blended artist set. Own lane (locked default).
  {
    const tmKey = env.TICKETMASTER_KEY ?? "";
    const concertsCfg = interests.concerts ?? { enabled: true, city: "Toronto", radius_km: 50, window_days: 60 };
    if (tmKey && concertsCfg.enabled) {
      out.push({
        id: "entertainment.concerts",
        lanes: ["concerts"] as LaneId[],
        collect: async (ctx) => {
          // Memoized in-process: music + concerts collect concurrently and
          // share one Spotify refresh without racing the token rotation.
          // Cold start (no tokens yet) falls back to the manual list.
          let artists: string[] = [];
          try {
            artists = await getSpotifyArtists(ctx, dataDir, env.SPOTIFY_CLIENT_ID ?? "", {
              topN: interests.music?.top_n ?? 25,
              timeRange: interests.music?.time_range ?? "short_term",
              manual: interests.music?.artists ?? [],
            });
          } catch {
            artists = readArtistCache(dataDir);
            for (const m of interests.music?.artists ?? []) {
              if (m && !artists.some((b) => b.toLowerCase() === m.toLowerCase())) artists.push(m);
            }
          }
          const rows = await collectConcerts(ctx, {
            apiKey: tmKey,
            city: concertsCfg.city ?? "Toronto",
            radiusKm: concertsCfg.radius_km ?? 50,
            windowDays: concertsCfg.window_days ?? 60,
            artists,
          });
          return concertRawItems(new Date().toISOString(), rows);
        },
      });
    }
  }

  // Games (experiment 012): Steam wishlist + ITAD universal-lowest.
  {
    const gamesCfg = interests.games ?? { steam_username: "Bitesh9", country: "CA", currency: "CAD" };
    out.push({
      id: "entertainment.games",
      lanes: ["games"] as LaneId[],
      collect: async (ctx) => {
        const { rows, itadOk } = await collectGames(ctx, new FileCache(dataDir), {
          username: gamesCfg.steam_username ?? "Bitesh9",
          country: gamesCfg.country ?? "CA",
          currency: gamesCfg.currency ?? "CAD",
          itadKey: env.ITAD_KEY ?? "",
        });
        return gamesRawItems(new Date().toISOString(), rows, itadOk);
      },
    });
  }

  // Music (experiment 004): Spotify artist set + MusicBrainz calendar.
  {
    out.push({
      id: "entertainment.music",
      lanes: ["releases"] as LaneId[],
      collect: async (ctx) => {
        const at = new Date().toISOString();
        const cache = new FileCache(dataDir);
        let artists: string[] = [];
        try {
          artists = await getSpotifyArtists(ctx, dataDir, env.SPOTIFY_CLIENT_ID ?? "", {
            topN: interests.music?.top_n ?? 25,
            timeRange: interests.music?.time_range ?? "short_term",
            manual: interests.music?.artists ?? [],
          });
        } catch (err) {
          ctx.log(`entertainment.music Spotify FAILED (${err instanceof Error ? err.message : err}) — manual artists only`);
          artists = [...(interests.music?.artists ?? [])];
        }
        const withMbids: { name: string; mbid: string }[] = [];
        for (const name of artists) {
          try {
            const mbid = await resolveArtistMbid(ctx, cache, name);
            if (mbid) withMbids.push({ name, mbid });
          } catch (err) {
            ctx.log(`entertainment.music resolve "${name}" FAILED (${err instanceof Error ? err.message : err})`);
          }
        }
        const now = Date.now();
        const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
        const releases = await collectReleases(
          ctx,
          cache,
          withMbids,
          iso(now - 30 * 86_400_000),
          iso(now + 60 * 86_400_000),
          interests.music?.show_reissues ?? true
        );
        return musicRawItems(at, artists, releases);
      },
    });
  }

  return out;
}
