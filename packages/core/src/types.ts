import { z } from "zod";

// §5.3 — lane ids. Configured, not hardcoded; this is the Phase 0 set.
export const LaneIdSchema = z.enum([
  "tech",
  "science",
  "math",
  "infrastructure",
  "canada-gta",
  "spaceflight",
  "launches",
  "holdings",
  "sports",
  "releases",
  "games",
  "concerts",
  "reddit-nba",
  "reddit-uwaterloo",
  "reddit-torontoraptors",
  "weather",
]);
export type LaneId = z.infer<typeof LaneIdSchema>;

export const TriggerSchema = z.enum(["stale", "scheduled", "manual"]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const LlmModeSchema = z.enum(["off", "rules-only", "llm"]);
export type LlmMode = z.infer<typeof LlmModeSchema>;

// §5.2 — CanonicalItem. id forms: `nf:<event_id>`, `yb:<symbol>` etc.,
// otherwise a hash of the canonical URL.
export interface CanonicalItem {
  id: string;
  lane: LaneId;
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  dek?: string;
  content?: string;
  publishedAt: string;
  fetchedAt: string;
  outlet?: string;
  tier: 1 | 2 | 3;
  engagement?: { score?: number; comments?: number };
  location?: string;
  tickers?: string[];
  rawRef: number;
}

export interface RawItem {
  adapter: string;
  fetchedAt: string;
  payload: unknown;
}

// §5.1 — SourceAdapter. Adapters never call the LLM and never write to the
// snapshot; they only produce RawItems.
export interface CollectContext {
  fromIso: string;
  toIso: string;
  settings: Settings;
  log: (msg: string) => void;
}

export interface SourceAdapter {
  id: string;
  lanes: LaneId[];
  collect(ctx: CollectContext): Promise<RawItem[]>;
}

// §5.5 — LLM stage interface. Every stage runs off | rules-only | llm.
// Two backends, not one router (experiment 013): Gemini is gated on
// REQUESTS ($0), Luna on DOLLARS ($0.05/day). Each pool carries both
// counters; the guard reads the one that binds for that provider.
export interface ProviderPool {
  dailyCapUsd: number;
  spentUsdToday: number;
  requestsToday: number;
  requestsPerDayCap: number;
  rpm: number;
}

export interface Budget {
  pools: Record<string, ProviderPool>;
}

export interface StageResult<O> {
  output: O;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  degraded: boolean;
  reason?: string;
}

export interface LlmStage<I, O> {
  name: string;
  model: string;
  mode: LlmMode;
  run(input: I[], budget: Budget): Promise<StageResult<O>>;
}

// --- config schemas (zod-validated at load) ---

const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  sport: z.string(),
  league: z.string(),
  abbr: z.string(),
  enabled: z.boolean(),
});

export const InterestsSchema = z.object({
  topics: z.record(
    z.object({
      keywords: z.array(z.string()).default([]),
      entities: z.array(z.string()).default([]),
      weight: z.number().default(1),
    })
  ),
  lane_budget: z.tuple([z.number(), z.number()]),
  sports: z.object({
    teams: z.array(TeamSchema),
    upcoming_games: z.number().default(5),
    show_preseason: z.enum(["label", "hide", "show"]).default("label"),
  }),
  watchlist: z
    .object({ shows: z.array(z.string()).default([]), movies: z.array(z.string()).default([]) })
    .default({}),
  music: z
    .object({
      use_spotify_top_artists: z.boolean().default(true),
      top_n: z.number().default(25),
      time_range: z.string().default("short_term"),
      blend_medium_term: z.boolean().default(true),
      artists: z.array(z.string()).default([]),
      show_reissues: z.boolean().default(true),
    })
    .default({}),
  movies: z
    .object({
      window_days: z.number().default(60),
      language: z.string().default("en"),
      people: z.array(z.string()).default([]),
      budget_min_m: z.number().default(20),
      bigness_fallback: z.string().default("major_studios"),
      major_studios: z.array(z.string()).default([]),
    })
    .default({}),
  tv: z
    .object({
      seen_shows: z.array(z.string()).default([]),
      window_days: z.number().default(60),
      language: z.string().default("en"),
      new_shows: z
        .object({
          popularity_min: z.number().default(15),
          confidence_min: z.number().default(0.75),
          scoring: LlmModeSchema.default("llm"),
        })
        .default({}),
    })
    .default({}),
  games: z
    .object({
      steam_username: z.string().default("Bitesh9"),
      country: z.string().default("CA"),
      currency: z.string().default("CAD"),
      deals_only: z.boolean().default(true),
    })
    .default({}),
  concerts: z
    .object({
      enabled: z.boolean().default(true),
      city: z.string().default("Toronto"),
      radius_km: z.number().default(50),
      window_days: z.number().default(60),
    })
    .default({}),
  reddit: z.object({
    subreddits: z.array(z.string()).min(1),
    top_n: z.number().min(1).max(25),
    top_comments_n: z.number().min(0).max(10).default(3),
    time_window: z.enum(["hour", "day", "week", "month", "year", "all"]).default("day"),
    exclude_title_patterns: z.array(z.string()).default([]),
  }),
  spaceflight: z
    .object({
      news_sites: z.array(z.string()).default(["Spaceflight Now", "SpaceNews", "NASA", "Ars Technica"]),
      search: z.array(z.string()).default([]),
      top_n: z.number().default(25),
      launches_limit: z.number().default(5),
    })
    .default({}),
  holdings: z.string(),
  weather: z.object({
    locations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        lat: z.number(),
        lon: z.number(),
        ec_station: z.string(),
      })
    ),
    default_location: z.string(),
    day_parts: z.record(z.tuple([z.number(), z.number()])),
  }),
  negative: z.array(z.string()).default([]),
});
export type Interests = z.infer<typeof InterestsSchema>;

export const SettingsSchema = z.object({
  timezone: z.string().default("America/Toronto"),
  refresh: z.object({
    on_open_stale_after_hours: z.number().default(24),
    daily_at: z.string().default("09:00"),
    skip_if_run_within_hours: z.number().default(3),
  }),
  windows: z.object({
    news_lookback_hours: z.number().default(24),
    entertainment_lookahead_days: z.number().default(60),
    sports_lookahead_days: z.number().default(14),
    sports_lookback_days: z.number().default(3),
    holdings_earnings_lookahead_days: z.number().default(30),
    holdings_results_lookback_days: z.number().default(7),
    concerts_lookahead_days: z.number().default(60),
  }),
  llm: z.object({
    daily_cap_usd: z.number().default(0.05),
    batch_max_items: z.number().default(60),
  }),
  audit: z.object({ keep_days: z.number().default(30) }),
});
export type Settings = z.infer<typeof SettingsSchema>;

const StageConfigSchema = z.object({ model: z.string(), mode: LlmModeSchema });

// Experiment 013: providers are first-class and pluggable (like adapters).
// google-ai-studio = free bulk (request-gated); backboard = paid fallback
// (dollar-gated). Adding a third provider is one config entry + one impl.
const ProviderSchema = z.object({
  base_url: z.string(),
  key_env: z.string(),
  transport: z.enum(["openai-shim", "backboard-threads"]),
  rpm: z.number().default(60),
  requests_per_day: z.number().default(1000),
  llm_provider: z.string().optional(),
}).passthrough();

export const ModelsSchema = z.object({
  providers: z.record(ProviderSchema),
  models: z.object({ bulk: z.string(), interactive: z.string() }).passthrough(),
  model_providers: z
    .object({ bulk: z.string(), interactive: z.string() })
    .default({ bulk: "google-ai-studio", interactive: "backboard" }),
  stages: z.object({
    select: StageConfigSchema,
    summarize: StageConfigSchema,
    dedupe: StageConfigSchema,
    digests: StageConfigSchema,
    taste: StageConfigSchema,
  }),
  budget: z
    .object({
      daily_cap_usd: z.number().default(0.05),
      over_cap_behavior: z.string().default("rules-only"),
      cache: z.object({ key: z.string(), ttl_days: z.number() }).passthrough().optional(),
    })
    .passthrough(),
  // Per-lane stage overrides, e.g. reddit: { summarize: { mode: off } }.
  // An override is permanent design, not degradation.
  overrides: z.record(z.record(StageConfigSchema)).default({}),
});
export type Models = z.infer<typeof ModelsSchema>;

// --- snapshot contract (frozen: the pipeline↔dashboard contract) ---

export const SnapshotItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  content: z.string().optional(),
  comments: z
    .array(
      z.object({
        author: z.string().optional(),
        score: z.number().nullable().optional(),
        body: z.string().optional(),
      })
    )
    .optional(),
  meta: z.object({ outlet: z.string().optional(), age: z.string().optional() }).passthrough().optional(),
  url: z.string().optional(),
  score: z.record(z.unknown()).optional(),
});
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

// Sources config — loose by design (families evolve independently), but the
// parts Phase 1 adapters consume are typed. Unknown families pass through.
const LaneQuerySchema = z
  .object({
    category: z.string().optional(),
    q: z.string().optional(),
    semantic: z.number().optional(),
    min_sources: z.number().optional(),
  })
  .passthrough();

export const SourcesSchema = z
  .object({
    newsflash: z
      .object({
        key_env: z.string(),
        base: z.string(),
        defaults: z
          .object({
            relevance_floor: z.number().optional(),
            langs: z.array(z.string()).optional(),
            min_sources: z.number().optional(),
            window_hours: z.number().optional(),
          })
          .passthrough()
          .optional(),
        lanes: z.record(LaneQuerySchema).optional(),
      })
      .passthrough()
      .optional(),
    reddit: z
      .object({ key_env: z.string(), auth: z.string().optional(), sort: z.string().optional() })
      .passthrough()
      .optional(),
    sports: z
      .object({
        base: z.string(),
        user_agent: z.string().optional(),
        upcoming_games: z.number().optional(),
      })
      .passthrough()
      .optional(),
    spaceflight: z
      .object({
        news: z.object({ base: z.string(), limit: z.number().optional() }).passthrough().optional(),
        launches: z
          .object({ base: z.string(), limit: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Sources = z.infer<typeof SourcesSchema>;

export const SnapshotSchema = z.object({
  generatedAt: z.string(),
  runId: z.number(),
  laneCounts: z.record(z.object({ shown: z.number(), collected: z.number() })),
  digest: z.object({ text: z.string(), generatedBy: z.enum(["llm", "template"]) }),
  laneStatus: z
    .record(z.object({ ok: z.boolean(), note: z.string().nullable() }))
    .optional()
    .default({}),
  lanes: z.record(z.unknown()),
  // Audit trail (§9.8): cut items with scores + reasons, capped per lane.
  // Optional so Phase 0/1 snapshots still parse.
  discarded: z
    .record(
      z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          reason: z.string(),
          ruleScore: z.number().nullable().optional(),
        })
      )
    )
    .optional(),
  cost: z.object({
    usdToday: z.number(),
    capUsd: z.number(),
    degraded: z.boolean(),
    // Per-provider usage (§8, experiment 013). usdToday is the Luna/Backboard
    // dollars; Gemini costs $0 so its pool reports requests against 30 RPD.
    providers: z
      .record(
        z.object({ requestsToday: z.number(), requestsCap: z.number(), spentUsd: z.number() })
      )
      .optional(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export function canonicalItemId(input: {
  id?: string;
  canonicalUrl?: string;
  url: string;
}): string {
  if (input.id) return input.id;
  const raw = input.canonicalUrl ?? input.url;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  return "url:" + (hash >>> 0).toString(16);
}
