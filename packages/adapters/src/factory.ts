import type { CollectContext, RawItem, SourceAdapter, LaneId } from "@detox/core";
import type { LoadedConfig } from "@detox/core";
import { collectEnvcan } from "./weather/envcan.js";
import { collectOpenMeteo } from "./weather/openmeteo.js";
import { collectMetno } from "./weather/metno.js";
import { collectReddit } from "./reddit/reddit.js";
import { collectNewsflash } from "./news/newsflash.js";

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

  return out;
}
