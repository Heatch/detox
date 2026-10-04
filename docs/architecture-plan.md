# Detox — Architecture and Tech Stack Plan

Working title: **Detox**. A personal, local-first morning dashboard.

This is a plan, not a spec. Feature sections describe what each feature does and how data flows through it, but deliberately stop short of committing to specific APIs. Candidate sources, account connections, and SDKs are listed per feature so experiments can pick winners later. Every final choice gets recorded in `docs/experiments/` (see [Experiment records](#experiment-records)).

Companion documents (all in `docs/` alongside this file; `AGENTS.md` at the repo root maps them for agents):

- `style-guide.md` — the visual system for the dashboard.
- `anti-ai-design-decisions.md` — the filter applied after the style guide; never overridden by it.
- `style-preview.html` — fake-content mockup of the proposed style.

---

## 1. Decisions made so far

Recorded so future changes can tell "deliberate" from "drifted".

| Area | Decision |
|---|---|
| Where it runs | Your own computer. Local-only, no public URL, no auth layer. |
| Refresh contract | On open: refresh if last successful refresh is older than 24 hours. Scheduled: refresh at 09:00 if the app is already running. Both non-blocking (see §4). |
| Frontend | Astro. Desktop-first. Dark only. |
| Language | TypeScript everywhere, pipeline included. |
| Storage | SQLite. |
| LLM access | Two providers, pluggable like adapters (experiment 013): Google AI Studio for free bulk work, Backboard for paid fallback. Neither speaks a generic OpenAI-compatible contract. |
| Model strategy | Gemini 3.8 Flash free tier for bulk daily work (5 requests/min, 30 requests/day — batch hard), GPT-5.6 Luna via Backboard for throttle fallback and interactive work. Per-stage model config, swappable. |
| LLM spend | Target ≈ $0.05/day on Luna/Backboard (Gemini costs $0 and is gated on requests instead), enforced by a per-provider budget guard; the pipeline degrades to rules-only rather than overspending or over-calling. |
| LLM role | Not fixed. Every LLM stage is pluggable per feature; rules-first, LLM-second everywhere so each stage can be enabled, disabled, or swapped independently. |
| Curation | Small number of strong, well-sourced items. Selection budget of 3–5 items per topic lane. Everything discarded is retained and reviewable, never silently lost. |
| Personalization | `config/interests.yaml` — keywords, topics, entities, teams, watchlist, negative filters. |
| Connected accounts | Spotify (OAuth, PKCE): my top 25 current artists (`user-top-read`) define the artist set — artist names only; release dates come from MusicBrainz (experiment 004). Toronto concerts via Ticketmaster Discovery (city-wide pull + attraction matching — experiment 003). Reddit (official OAuth app). More later if needed. |
| Music release calendar | MusicBrainz alone, release-level queries (`status:Official`, deduped per release-group). Newsflash is rejected for music — it stays the news-lanes backbone only (experiment 004). |
| Movies | TMDB, two tiers: actor watchlist (`people` list, pipe-OR `with_people`, no filters) + everyone else (English, and big enough = budget ≥ $20M when known, else major-studio production company). Budget is usually missing on upcoming films — the studio fallback is load-bearing (experiment 010). |
| TV | TMDB, three parts: seen shows → new seasons (always show; `seasons[]` tail is the signal, `next_episode_to_air` is empty for most returning shows); new shows → gate (TV-scale `popularity_min` OR `confidence_min`); confidence = rules (genre/creator/network overlap with the seen-shows profile) + `taste` LLM stage returning per-show reasons (experiment 011). |
| Games | Steam wishlist (keyless `IWishlistService` chain, username configurable) + ITAD `POST /games/prices/v3` for **universal-lowest** sale prices (min across all shops, winning shop named — `deals=true`: old/new price, % off). Keyless bulk appid→UUID lookup; Steam `appdetails` is the no-key fallback (experiment 012). Awaiting the ITAD **API key** (distinct from the OAuth pair already in `.env`). |
| Reddit access | Official API app (OAuth), RSS as fallback, both behind the adapter interface. |
| News backbone | Newsflash (newsflash.sh) is the primary news source — deduped event graph with corroboration counts and canonical summaries. RSS is gap-filler duty only (see experiment 001). Spaceflight is excluded from Newsflash — see below. |
| Spaceflight | Spaceflight News API (`api.spaceflightnewsapi.net/v4`) for the news lane; Launch Library 2 (`ll.thespacedevs.com`) for a standalone upcoming-launches section. Both keyless (experiment 007). |
| News presentation | Headlines + one-line summaries, grouped by topic lane, source always named. |
| Weather | Multiple independent sources, shown side by side with a computed consensus and a note when they disagree. |
| Sports | Schedule + injury report only, **no news** (experiment 009). ESPN site API, one endpoint shape across leagues. Team registry in `interests.yaml` — Raptors enabled; Jays, Leafs, Tempo are config-only flips. |
| Holdings | Tickers from `config/holdings.md` (a markdown list, Canadian and US). A Holdings lane shows important company news, upcoming earnings dates, and results for earnings that just landed. **Yahoo Finance is the single source** — per-symbol news RSS + `quoteSummary` earnings (experiment 008). CDRs map to their underlying company; ETFs excluded. |
| Typography | Serif headlines and summaries, quiet sans for controls and metadata. |
| Colour | Deep slate canvas, warm off-white ink, muted gold accent. Dark only. |

Deliberately left open: every other specific API/SDK choice, LLM prompt design, which LLM stages stay on outside the news lanes, per-lane Newsflash query specs, and how many sources weather settles on.

---

## 2. Design principles

1. **Local-first and yours.** Data, keys, and history live on your machine in one SQLite file. Nothing phones home except the source APIs and the two LLM providers.
2. **Morning-first.** The page answers "what should I know today" in one screenful per lane. Depth exists below, not in front.
3. **Curation over volume.** A small set of strong, well-sourced items beats a complete feed. Selection is a budget, not a filter that loses data.
4. **Rules first, LLM second.** Deterministic code does scoring, sorting, dedupe candidates, and weather consensus. The LLM adds judgment where rules are weak. Every LLM stage can be turned off and the dashboard still works.
5. **Every seam is swappable.** Sources, models, and prompts sit behind small interfaces so experiments are cheap and reversals are boring.
6. **Show your work.** The dashboard states how many items were collected, how many shown, what was merged, and what the LLM cost. Trust comes from auditability.
7. **Fail soft.** A dead API or a throttled model degrades one lane, never the page.

---

## 3. System overview

```
 config/interests.yaml  config/sources.yaml  config/models.yaml
        │                     │                     │
        └──────────────┬──────┴─────────────────────┘
                       ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Collect — one adapter per source family                 │
   │  reddit/  spotify/  weather/{envcan, openmeteo, metno…}  │
   │  nba/  entertainment/  finance/  news/{newsflash, rss}   │
   └──────────────┬───────────────────────────────────────────┘
                  ▼  RawItem[] (raw payload stored for provenance)
   ┌──────────────────────────────────────────────────────────┐
   │  Normalize — CanonicalItem, source tiers, timestamps,    │
   │  canonical URLs, location and team normalization         │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Dedupe — lexical pass (URL/title/SimHash), optional     │
   │  embedding clustering, LLM merge decisions (batched)     │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Select — rule scoring, then LLM selection within the    │
   │  per-lane budget (3–5), with rationale. Cut items kept.  │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Summarize — one-line summary per selected item, optional│
   │  lane digest. Weather consensus computed arithmetically. │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Assemble — snapshot.json per lane + cost accounting     │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   SQLite (data/detox.db) ──► Astro dashboard on localhost
                              (reads last snapshot instantly,
                               triggers refresh when stale)
```

Two deliverables in one repo: the **pipeline** (collect → snapshot) and the **dashboard** (renders snapshots). They share types and the SQLite layer.

---

## 4. Runtime and the refresh contract

Runs on Windows on your machine. One local daemon: Astro in Node standalone mode serves the dashboard on `localhost`, and the same process runs the pipeline and the scheduler. Started at login via Task Scheduler (with a `pnpm start` fallback you can run by hand).

**The contract, exactly as decided:**

1. **On open.** Page load calls `GET /api/state`, which returns the current snapshot plus `lastSuccessfulRun`. If that is older than 24 hours, the frontend fires `POST /api/refresh` and renders the cached snapshot immediately. No spinner; a quiet status line reads like "Updated 7:02 yesterday. Refreshing now."
2. **At 09:00.** If the daemon is running, a full pipeline run starts (America/Toronto). Guard: skip if a successful run finished within the last 3 hours, unless forced. If the machine is off or asleep, this run is simply missed; the on-open rule catches it next time.
3. **Manual.** A Refresh control always exists in the masthead.
4. **Never blocking.** A refresh in progress never blanks or reflows the page. When the new snapshot lands, sections update in place and the status line settles to "Updated 9:04 this morning."

The scheduler is one module with three triggers (stale-on-open, daily timer, manual) calling the same `runPipeline()` entry point, and every run is logged in the `runs` table with its trigger, duration, outcome, and cost.

**Failure behavior per lane:** a failing adapter records an error on the run, marks its lane stale ("Weather data is from 8:02 yesterday — Environment Canada did not respond"), and leaves other lanes untouched.

---

## 5. Core abstractions

These are the seams that make experimentation cheap. Implement them narrowly; widen only on demand.

### 5.1 SourceAdapter

```ts
interface SourceAdapter {
  id: string;                       // "weather.openmeteo", "news.rss.polygon"
  lanes: LaneId[];                  // which lanes this can feed
  collect(ctx: CollectContext): Promise<RawItem[]>;
  // CollectContext carries: fetch window, rate limiter, cache, settings, logger
}
```

One adapter per source family, one file per candidate source where practical. Swapping a provider means writing one file and editing `sources.yaml`. Adapters never call the LLM and never write to the snapshot; they only produce `RawItem`s.

### 5.2 CanonicalItem

```ts
interface CanonicalItem {
  id: string;                 // hash of canonical URL, or `nf:<event_id>` for Newsflash events
  lane: LaneId;
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  dek?: string;               // source-supplied description
  publishedAt: string;        // ISO
  fetchedAt: string;
  outlet?: string;
  tier: 1 | 2 | 3;            // source credibility weight, per sources.yaml
  engagement?: { score?: number; comments?: number };
  location?: string;          // normalized, for weather and GTA news
  tickers?: string[];         // normalized tickers, for the holdings lane
  rawRef: number;             // FK to raw payload
}
```

LLM outputs (summaries, scores, rationale) live in separate tables keyed by item and run, so the item record stays provenance-pure and prompt iterations never corrupt it.

### 5.3 Lane

A lane is a named slice of the page with a selection budget and a sort policy: `tech`, `science`, `math`, `infrastructure`, `canada-gta`, `spaceflight` (news), `launches`, `holdings`, `sports` (one block per configured team), `releases`, `games` (wishlist sales), `reddit-nba`, `reddit-uwaterloo`, `weather`. Lanes are configured, not hardcoded; adding one should be config plus at most one adapter.

### 5.4 InterestConfig (`config/interests.yaml`)

```yaml
topics:
  infrastructure:
    keywords: [tunnel boring, high-speed rail, gigafactory, grid interconnect]
    entities: [Crossrail, Brightline, Ontario Line]
    weight: 1.2
sports:
  teams:
    - { id: raptors,  name: Toronto Raptors,   sport: basketball, league: nba,  abbr: tor, enabled: true }
    - { id: bluejays, name: Toronto Blue Jays, sport: baseball,   league: mlb,  abbr: tor, enabled: false }
    - { id: leafs,    name: Toronto Maple Leafs, sport: hockey,   league: nhl,  abbr: tor, enabled: false }
    - { id: tempo,    name: Toronto Tempo,     sport: basketball, league: wnba, abbr: tor, enabled: false }
  upcoming_games: 5
watchlist:
  shows: [The Long Corridor]
  movies: [Salt Flats]
music:
  use_spotify_top_artists: true       # top 25 by affinity, refreshed per run (see experiment 002)
  artists: [Halcyon Fields]          # manual supplement Spotify's ranking misses
concerts: { city: Toronto, radius_km: 50, enabled: true }   # bonus lane, sources untested
holdings: config/holdings.md         # tickers live in their own markdown file
subreddits: [nba, uwaterloo]
negative: [crypto prices, celebrity]
```

Validated with zod at load time; the dashboard footer can show a read-only summary of what was applied.

### 5.5 LLM stage interface

```ts
interface LlmStage<I, O> {
  name: string;               // "dedupe.merge", "select.tech", "summarize.items"
  model: string;              // resolved from config/models.yaml
  schema: ZodSchema<O>;       // structured output contract
  run(input: I[], budget: Budget): Promise<StageResult<O>>;
}
```

Every stage declares its model, its schema, and its cost ceiling. Stages are individually switchable in `models.yaml`, and a stage can run `off | rules-only | llm`.

---

## 6. Data model (SQLite sketch)

Draft schema; expect it to evolve. Migrations via Drizzle Kit or Kysely (either is fine — see stack table).

| Table | Purpose |
|---|---|
| `runs` | One row per pipeline run: trigger, start/end, status, error, tokens in/out, estimated USD. |
| `raw_items` | Verbatim payloads per adapter fetch. Provenance and reprocessing without refetching. |
| `items` | Normalized `CanonicalItem` rows, including `content` (full Reddit post text). |
| `clusters`, `cluster_items` | Dedupe clusters; a headline seen by five outlets is one cluster of five items. |
| `selections` | Per run, per lane: item picked or cut, rule score, LLM score, rationale, summary. Cut rows are the audit trail. |
| `weather_forecasts` | Per run, per source, per location: issued time, hourly + day/night temperatures, precip (mm + likelihood), wind (speed/direction/gust), humidity, context text (EC `textSummary`), raw payload. |
| `weather_consensus` | Per run: median values, spread per metric, disagreement note. |
| `games`, `injuries` | Raptors schedule/results and injury rows with source and as-of time. |
| `releases` | Upcoming entertainment: kind, title, artist/studio, date, region, where. |
| `holdings` | Tickers from `config/holdings.md`: ticker, exchange, company name, optional note, date added. |
| `earnings_events` | Per ticker: period, date, upcoming or recent, EPS and revenue actual vs estimate, guidance note, source. |
| `llm_calls` | Per call: stage, model, tokens, cache hit, latency, estimated USD. Drives the budget guard and the footer cost line. |
| `feedback` | Reserved for thumbs up/down once you want it. Unused at first. |
| `settings_snapshot` | The resolved config at run time, so old runs can be interpreted correctly. |

Snapshots for the UI are written as plain JSON files (`data/snapshots/<date>.json`) as well as living in the DB — the dashboard reads JSON, the DB keeps history. Backing up = copying one directory.

---

## 7. Pipeline stages in detail

1. **Collect.** Adapters run concurrently under per-source rate limits, honoring ETags and conditional requests where offered. Windows: news and Reddit look back 24–48h; entertainment looks forward 30–60 days; sports forward 14 days and back 3; holdings look forward 30 days for earnings dates and back 7 for results; weather is "now" plus 7 days.
2. **Normalize.** Canonical URLs (strip tracking params), normalized titles, timezone-aware timestamps (America/Toronto), outlet names, tier lookup from `sources.yaml`.
3. **Dedupe.** Newsflash events arrive pre-clustered with stable IDs (`nf:<event_id>`), so news-lane dedupe collapses to identity plus lane assignment — the same event ID surfacing in two lane queries is free cross-lane dedupe. For everything else, cheap first: canonical URL equality, normalized-title equality, SimHash over title+dek. Then, only for near-misses, optional embedding similarity to group clusters. LLM merge/split review of ambiguous cluster pairs is **deferred to the backburner** (user decision 2026-09-30) — revisit only if the gold set shows lexical dedupe failing. The merge decision is stored, so identical stories cost nothing tomorrow (content-hash cache).
4. **Select.** Rule score first: recency decay, source tier, keyword and entity hits from `interests.yaml`, engagement percentile, cluster size (many outlets covering it is a signal), negative-filter penalty. For news lanes this is the whole selection step: corroboration threshold + relevance floor + negatives + recency sort, no LLM (see experiment 001). For other lanes, one batched LLM call re-ranks the top ~25 candidates and returns 3–5 picks with a short rationale each. The rule score and LLM score are both stored so disagreements are visible.
5. **Summarize.** One line per selected item (≤ 25 words), naming the source and stating uncertainty plainly. News lanes use the Newsflash canonical summary (cleaned of entities and emoji, with a fallback to the first corroborating article's dek) — no LLM. Reddit items summarize over **title + full post text (`selftext`) + top comments** via the LLM `summarize` stage (user decision 2026-09-30); link posts fall back to title + comments. The morning digest runs as its own `digests` stage (**ON** — the two-sentence line for the dashboard top). Also one batched call per stage.
6. **Assemble.** Build the snapshot: lanes, items, rationales, transparency counts (collected, merged, shown, cut), weather consensus (median of sources, arithmetic — no LLM), sports blocks, cost totals.

**Budget guard.** Before each stage, check the pool that binds for its provider: dollars for Luna/Backboard (`daily_cap_usd`, default 0.05), request count for Gemini (30/day, 5/min). Track real spend and real request counts in `llm_calls`. Over either cap → that provider refuses, the stage falls through to the other provider, and only then to rules-only; the footer says which. Cached rows count toward neither cap.

**Caching.** `hash(stage version + item content)` → stored output in `llm_cache` (30-day TTL). Unchanged content is never re-sent to a model. This is what makes the 5 requests/min and 30 requests/day limits painless.

---

## 8. LLM layer

**Providers.** One `LlmProvider` interface, two transports (experiment 013) — Google AI Studio speaks an OpenAI-style shim (`POST {base}/chat/completions`, Bearer key), Backboard speaks its own threads API (`POST {base}/threads/messages`, `X-API-Key` header, per-message `llm_provider` + `model_name`). `config/models.yaml` maps stages to models and models to providers:

```yaml
stages:
  select:      { model: gemini-3.8-flash, mode: llm }
  summarize:   { model: gemini-3.8-flash, mode: llm }   # Reddit override stays llm (title + selftext + comments)
  dedupe:      { model: gpt-5.6-luna,     mode: llm }
  digests:     { model: gemini-3.8-flash, mode: llm }   # morning digest: ON (user decision 2026-09-30)
```

News lanes override these defaults per experiment 001: `select` and
`summarize` run `rules-only`/`off` (Newsflash supplies dedupe, corroboration,
and summaries), and the LLM budget is reserved for `digests` and taste-level
tiebreaks.

**Model guidance (checked against published pricing, September 2026):**

- **Gemini 3.8 Flash (free tier)** — input and output free of charge, capped at 5 requests/min, 30 requests/day, and 1M-token input context. Thinking tokens bill as output only on paid tiers. Perfect for the daily bulk if calls are batched and the pipeline is patient. Caveats: the free tier's terms can change, introductory paid pricing ($0.75/$3.75 per 1M) doubles on 2027-01-01, and 30 RPD shapes the pipeline more than the price does — two calls per run is a ~15-run daily ceiling shared with evals.
- **GPT-5.6 Luna (via Backboard, provider `openai`)** — $0.20/$1.20 per 1M (confirmed live on the Backboard model library), ~1M-token context, JSON output supported. At those rates the $0.05/day target buys on the order of 250K input plus 40K output tokens uncached, and far more with cache hits. Ideal for throttle fallback when Gemini starves, interactive calls, and retries. A starved Gemini falls through to Luna by design — evals share the same pools, so a big eval day spends real cents.

**Working the 5 RPM / 30 RPD limits:**

- Batch 20–60 items per call (both models have ~1M context; a lane's candidates fit easily).
- Token-bucket queue at 4 requests/min with exponential backoff; throttled work is queued and resumed, never restarted. 503s from Gemini are transient — retry, then fall through to Luna.
- Route interactive and on-demand paths to Luna so the page never waits on the throttle.
- Cache aggressively (content hash + prompt version, `llm_cache`, 30-day TTL) so a second run over the same items costs zero calls and zero requests against the daily cap.

**Structured outputs.** Every stage returns JSON validated by its zod schema; invalid output is retried once with the validation error, then falls back to rules-only for that lane.

**Eval harness.** `evals/gold.jsonl` holds labeled items (relevant/not, duplicate-of, summary quality). `pnpm eval` runs the current prompts against it and reports precision@k for selection, dedupe accuracy, summary drift, and cost per run. Prompt changes run the harness before they land. This is how "does the LLM actually know what's relevant to me" gets answered with data instead of vibes.

**Degradation ladder.** A provider unreachable → retry with backoff, then swap to the fallback provider for that stage. One model throttled → retry queue, then Luna. Over budget → summaries off, selection rules-only, digest templated. The dashboard always renders; it always says which of these is active.

---

## 9. Features

Each feature: what it shows, how it flows, candidate sources (open), experiments to run, and open questions. The word "candidate" is doing real work — nothing here is committed.

### 9.1 Morning header and digest

**Shows.** Date, a two-sentence morning line (weather headline, next game, earnings reporting today, anything the selection marked urgent), refresh status, and the transparency line: "Selected 24 of 318 items. 12 clusters merged. LLM cost $0.011 of $0.05."

**Flows.** Digest line is assembled from lane-level highlights; the LLM writes it only after selection is done, and only if the summarize stage is on. Otherwise the line is templated from the top items.

**Candidates.** None — internal.

**Experiments.** Is the digest earning its screen space, or is it a recap of what's two inches below?

**Open questions.** Should it lead with weather or with the most urgent item?

### 9.2 Weather (multi-source)

**Shows.** A per-location block with an easy pill toggle (Waterloo, Vaughan, Toronto — config-driven). The hero is **today by day part**: four columns (morning, afternoon, evening, night), each with the median temperature in large serif and the three source values stacked beneath in small tabular type — one number to read, three to check. Below: the full **7-day** as one row per day with per-source high/low pairs and a consensus column in gold; where sources disagree past the threshold the consensus cell states the spread ("15° to 18°"). Preview validated against live data: `docs/weather-preview.html`.

**Flows.** Three independent sources per location (decided — experiment 006): Environment Canada citypage (`on-143`/`on-64`/`on-82` stations), Open-Meteo (lat/lon), MET Norway (lat/lon) — all keyless. Each adapter stores its own forecast rows per run; day parts are mean temperature over local hours (6–11, 12–17, 18–21, 22–05); consensus is the median per cell; the disagreement note is templated, not LLM-written. Historical runs enable accuracy tracking later. Quirks handled per experiment 006: EC/MET hourly windows start at the current hour (cache per run to fill morning gaps in afternoon snapshots), EC payloads are `{en, fr}` nested, MET Norway needs a proper User-Agent and a working CA bundle.

**Data contract** — what the lane consumes per location (field map verified live, experiment 006):

| Data | Environment Canada | Open-Meteo | MET Norway |
|---|---|---|---|
| Temperature | hourly `temperature` (24 h) + day/night period highs/lows | `temperature_2m` hourly (168 h) + `daily max/min` | `instant.details.air_temperature` (hourly ~59 h, then 6-hourly ~9 days) |
| Precipitation | hourly `lop` (likelihood % + category) | `precipitation` (mm) + `precipitation_probability` (%) | `next_1_hours`/`next_6_hours` `precipitation_amount` (mm); pop optional/absent |
| Wind | hourly `wind.speed` (km/h) + `wind.direction` (compass + full name); period `winds` with bearing/rank | `wind_speed_10m`, `wind_gusts_10m`, `wind_direction_10m` | `instant` `wind_speed`, `wind_from_direction` (no gusts) |
| Humidity | period `relativeHumidity` + `currentConditions` (no hourly) | `relative_humidity_2m` hourly | `instant` `relative_humidity` |
| Context text | **period `textSummary`** — free plain-language line ("A mix of sun and cloud. Wind becoming south 20 km/h this afternoon. High 23. Humidex 28.") | — (compose from values if needed) | — (compose from values if needed) |
| Extras available | `humidex`, `uv`, `warnings`, sunrise/sunset | humidex/windchill on request | `cloud_area_fraction`, `air_pressure_at_sea_level` |

The lane renders: day-part medians (temperature hero), precip/wind/humidity per part or as a summary line (density pass pending), the 7-day per-source high/low table with consensus, and EC's `textSummary` as the lane context line — no LLM text needed for weather. `warnings` feed a future alerts lane.

**Candidates (verify current terms before committing):**

| Candidate | Why it's a candidate | Watch out for |
|---|---|---|
| Environment Canada / MSC GeoMet (`api.weather.gc.ca`) | **Chosen** (experiment 006): the official Canadian source, keyless, exact stations per city, day/night periods + hourly + warnings in one payload. | `{en, fr}` nested values; hourly window runs forward from now; 6.5-day horizon. |
| Open-Meteo | **Chosen** (experiment 006): keyless, cleanest payload, 7 full days of hourly data per exact lat/lon. Also has a historical-forecast API for scoring accuracy. | Aggregates models, so "Open-Meteo says" may mean "one of its models says". |
| MET Norway (yr.no) | **Chosen** (experiment 006): keyless, independent model provenance (ECMWF-based), ~9-day horizon. | User-Agent etiquette; coarser (6-hourly) beyond 48 h; TLS quirk on this host (use curl/pinned CA). |
| NWS (`api.weather.gov`) | Free, official US, model-diagnostic discussions. | US only; useful only for travel. |
| OpenWeatherMap / WeatherAPI.com / Tomorrow.io / Pirate Weather | Private-sector fourth opinions with easy keys. | Free-tier caps, less Canadian tuning; only worth it if the big three prove insufficient. |

**Experiments.** Sources decided (experiment 006, including precip/wind/humidity field mapping — all available on all three). Remaining: a density pass on the weather block before adding variables (current layout takes too much space); does the consensus beat any single source over a month (accuracy tracking, using Open-Meteo's historical-forecast API)? Do EC's `warnings` deserve their own alerts lane?

**Open questions.** Hourly detail or daily only? Include radar image snapshots (GeoMet tiles) or keep it typographic?

### 9.3 Sports: upcoming games + injuries (Raptors first, extensible)

**Shows.** Per configured team: the next few games (date, opponent, time, venue, broadcast) and a compact injury table (player, status, note, return date). **No news from this feature** — Reddit covers the talk and Newsflash covers the headlines; this section is strictly schedule + injury report. First team: Raptors. The Jays, Leafs, and Tempo must slot in as config-only additions (validated live — experiment 009).

**Flows.** ESPN's site API, two endpoints per league (decided — experiment 009): `GET /apis/site/v2/sports/{sport}/{league}/teams/{abbr}/schedule` and `GET .../{league}/injuries` (league-wide; filter to the Toronto group by `displayName`). The team registry in `config/interests.yaml` is the whole "add a team" surface: `{id, name, sport, league, abbr, enabled}` — flipping `enabled` on the Jays/Leafs/Tempo rows is all that's needed. Adapter rules from the experiment: **plain-library User-Agent only** (ESPN's WAF 403s custom and browser UAs — inverted from every other source we use); one injuries fetch per enabled league; render empty schedules gracefully (Jays are at 0 games in the offseason); label preseason (`seasonType=pre`) rows; compose injury text from `details` (type/side/returnDate) when `shortComment` is junk ("ir-nr"); carry `returnDate` but distrust league padding (Tempo's all read 2027-05-01). Injury status vocabulary is league-specific (NBA `Day-To-Day`, MLB `15-Day-IL`, NHL `IR-LT`, WNBA `Out`) — never assume one shape. Injury rows are structured data, never LLM-written.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| ESPN's site API (schedule + injuries JSON) | **Chosen** (experiment 009): one endpoint shape for NBA/MLB/NHL/WNBA — the multi-team requirement falls out free. Injury payloads carry type/side/returnDate and reporter-attributed notes. | **WAF quirk: plain-library UA only** (browser/custom UAs → 403). Undocumented endpoints; `shortComment` sometimes junk; league-specific status vocabularies. |
| NBA.com stats endpoints (via `nba_api`) | The official data; richest box scores and standings. | NBA-only, fragile headers, Python-first SDK in a TS repo. Warm fallback. |
| NBA official injury report (published as PDF) | The source other sites copy. | PDF parsing and twice-daily publication times. NBA-only. Warm fallback for injury accuracy checks. |
| Rotowire / NBC Sports injury pages | Faster human-curated injury notes. | Scraping; derivative sources. |
| Basketball Reference | Historical depth, sanity checks. | Scraping and rate limits. |

**Experiments.** Sources decided (experiment 009). Remaining: does ESPN's injury list carry game-day updates fast enough vs the official NBA PDF report (spot-check)? Do `broadcasts[]` fill in for regular season (TSN/Sportsnet on the game row)? Filter or show non-injury entries ("Coach's Decision", "Personal")?

**Open questions.** Game-day promotion — should the team block rise on game days (now cheap: `status.detail` carries the time)? Should preseason games be hidden or just labeled?

### 9.4 Entertainment releases + Toronto concerts

Four sub-features with independent sources (the UI may render them together in "Coming up", but movies and TV are separate features — different volumes, possibly different sources):

**Music (decided — experiments 002, 004).** Spotify supplies the **artist set only** — OAuth Authorization Code with PKCE (`user-top-read`), one `GET /me/top/artists` per run (top 25, `short_term`; `interests.yaml` entries supplement). The release calendar comes from **MusicBrainz at release level**: per-artist `GET /ws/2/release?query=arid:<mbid> AND date:[today−30d … today+60d]`, `status:Official` only (bootlegs lurk), deduped per release-group (deluxe editions appear many times), dates rendered by precision ("October 2026", not "31 October"), kind tagged (album, single, deluxe, reissue, soundtrack) from primary + secondary types. Spotify's catalog scan is **retired** (experiment 004).

**Movies (decided — experiment 010).** TMDB, two tiers over a 60-day window:

1. **Actor watchlist, always shows.** A `people` list in `interests.yaml` resolved to person IDs (`/search/person`, cached forever), then one `discover/movie?with_people=<id1|id2|…>` pipe-OR query. No language/budget filter — if a listed person is in it, it appears ("we need to see it"). `with_people` over `with_cast` so producer/director credits match too.
2. **Everything else: English + big enough.** `with_original_language=en`, and "sufficiently big" by composite rule — **budget ≥ $20M when known, else production company in the configured major-studio list**. Budget is 0/unknown for most upcoming films (3 of 12 in the sample — including *Street Fighter* and a Blumhouse title), so the studio fallback is what makes the tier work. Rows carry the reason: "with Zendaya", "$40M budget", "Legendary Pictures". Ordering by popularity only — it spikes near release and is not a size signal (verified: an indie at pop 226 vs Hunger Games at 15). Attribution required in the footer: "This product uses the TMDB API but is not endorsed or certified by TMDB."

**TV (decided — experiment 011).** TMDB again, but a three-part design because "new seasons of shows I've seen" and "new shows I might like" are different problems:

1. **Seen shows → new seasons (always shows).** `tv.seen_shows` in `interests.yaml` (titles → IDs, cached). The new-season signal is the `seasons[]` array tail, **not** `next_episode_to_air` (verified: empty for most returning shows — Severance, Wednesday, Last of Us would show nothing). Dated future season → "Season N, starts <date>"; `air_date: null` + `Returning Series` → "Season N announced, no date yet". No LLM.
2. **New shows → confidence gate (OR logic).** `discover/tv?first_air_date…&with_original_language=en` (98 in the test window). Show if `popularity ≥ tv.popularity_min` (TV scale — max 20.3 observed, seeded at 15) **or** confidence ≥ `tv.confidence_min` (seeded 0.75).
3. **Confidence = rules + LLM combination.** Rule component (genre histogram vs the seen-shows profile, creator overlap, network overlap) computes always and degrades gracefully; the `taste` LLM stage (batched, one call per run) sees the profile + candidates and returns `{id, confidence, reason}` — the reason renders as the row's rationale. `off | rules-only | llm` per `models.yaml`. The seen-shows list is itself the taste profile — no separate training step.

Dead end recorded: `trending/tv/week` tracks viewing, not anticipation (0/20 unaired) — not usable as the "very popular" gate.

**Toronto concerts (decided — experiment 003).** Ticketmaster Discovery with a city-wide pull (one paginated query for all Toronto music events in the window) and client-side attraction-name matching against the blended artist list. Per-artist keyword search is a proven trap (`keyword=Drake` → 31 events, zero Drakes; `keyword=Taylor Swift` → a tribute dance party). Rows show date, artist, venue. First real finds: Olivia Rodrigo (Oct 26–27), Doja Cat (Nov 25), Tyla (Nov 26). Open design call: tag concerts inside "Coming up" or give them their own lane.

**Candidates and status:**

| Candidate | Status | Notes |
|---|---|---|
| Spotify Web API | **Chosen** for artist set only (002, 004) | Catalog scanning retired; rate-limit penalties under scan patterns. |
| MusicBrainz | **Chosen** for music releases (004) | Release-level queries; `status:Official`; dedupe per release-group. |
| TMDB | **Chosen** for movies (010) and TV (011) | Two-tier watchlist + bigness design for movies; three-part seen-shows/gate/taste design for TV. Budget gap on movies handled by studio fallback. |
| Ticketmaster Discovery | **Chosen** for concerts (003) | City-wide pull + attraction matching; keyword search is a trap. |
| TVmaze / Trakt | Untried, superseded by TMDB TV (011) | TVmaze remains a fallback if TMDB TV coverage ever lags. |
| Songkick / Bandsintown | Rejected for concerts (003) | No usable public city/date API / access terms. |
| Watchmode | Untried | Streaming dates, if "where it lands" matters later. |

**Experiments.** All four sub-features decided (003, 004, 010, 011). Remaining: the artist-set blend (Tyla's concert is the one data point); bigness-fallback tuning for movies; TV threshold tuning (`popularity_min`, `confidence_min`) against the gold set; "coming up" as list vs calendar strip.

**Open questions.** Do concerts belong in "Coming up" or their own lane? Do you want "out today" highlighted or is forward-looking enough? Soft 60-day window for watchlist hits ("in the next 60 days if possible" — extend to 75 for tier 1, or surface near-misses quietly)?

### 9.5 Reddit (r/nba, r/torontoraptors, r/uwaterloo)

**Shows.** Per subreddit: 3–5 posts with title, a one-line summary where the thread is substantive, and tabular score and comment counts. Game threads and spoilers filtered by config. Links go to the thread.

**Flows.** Retrieval validated (experiment 005): official Reddit API with app-only OAuth (client credentials, token cached 24 h), `GET /r/{sub}/top?t={window}&limit={n}&raw_json=1` plus `GET /comments/{id}?sort=top&depth=1&limit={top_comments_n}` per kept post, with `subreddits`, `top_n`, `top_comments_n`, `time_window`, and `exclude_title_patterns` all read from `config/interests.yaml`. Retrieval fetches **full post content (`selftext`) and the top comments in full** — stored as `items.content` + `comments[]`. **No LLM involvement with Reddit, ever** (user decision 2026-10-01): the lane renders posts and comments raw, and the `summarize` stage for Reddit lanes is `off` (an explicit `overrides` entry in `models.yaml`, not a degradation). Reddit's own `top` sort is by upvotes. `score`/`num_comments`/`upvote_ratio`/flair feed rule scoring; flair is also a filter dimension (Meme, game threads). Quirks to handle: vote fuzzing (scores aren't stable keys), per-subreddit score scales (14k vs 69 — no global thresholds), comment scores can be negative or outscore the post, `kind: t1` on the listing wrapper, UTF-8 flair. Summaries are LLM-written over title + top comments in one batched call; low-comment posts skip summarization entirely and just show the title. Adding r/toronto is a config edit.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| Official Reddit API (OAuth app, client credentials) | **Validated and adopted** (experiment 005): `top?t={window}&limit={n}`, app-only token cached 24 h. | Vote fuzzing (scores not stable keys), per-subreddit score scales, `raw_json=1` required, UTF-8 flair. |
| PRAW (Python) | Excellent SDK for the official API. | Python in a TS repo — fine if the pipeline leans Python, otherwise do the OAuth flow directly over fetch. |
| RSS (`.rss` endpoints) | Keyless fallback for titles and links. | No scores, no comments, no summaries. |
| Unofficial `.json` endpoints | Rich and keyless. | Can break or block without warning; fallback only. |
| Arctic Shift / PullPush | Historical search if you later want "what did r/nba say last week". | Third-party archives; data quality varies. |

**Experiments.** Retrieval is settled (experiment 005). Does summarizing top comments add value over the title alone? What's the smallest comment count where a thread deserves a summary? Per-subreddit score normalization if a combined lane view is ever wanted.

**Open questions.** Should r/uwaterloo get its own lane or share a "Reddit" lane with subreddit tags? How are game threads handled — pinned in the Raptors section, hidden, or collapsed?

### 9.6 News lanes (tech, science, math, infrastructure, Canada/GTA)

**Shows.** Per lane: 3–5 items as headline + one-line summary + outlet and age. Cross-lane dedupe means one story appears in one lane only, with its cluster size visible in the audit view. (Spaceflight has its own sources and section — see §9.11.)

**Flows.** The news backbone is **Newsflash** (locked in — see experiment 001),
not RSS. One `newsflash` adapter issues the per-lane queries from
`sources.yaml`, maps events to `CanonicalItem`s with `id: nf:<event_id>`, and
applies the adapter cleanup pass: bearer auth, ETag/conditional requests,
client-side English filter (no `lang` param exists — drop non-English-only
events via `sources[].lang`), HTML-entity decoding, null-summary fallback to
the first corroborating article's dek, and sorting by confidence + recency
(the API's default order is not importance). Per-lane query specs in
`sources.yaml`:

```yaml
newsflash:
  key_env: NEWSFLASH_API_KEY
  lanes:
    tech:           { category: tech, min_sources: 2 }
    science:        { category: science, min_sources: 2 }
    infrastructure: { q: "major infrastructure project construction", semantic: 1, min_sources: 2 }
    canada-gta:     { q: "Canada", min_sources: 2 }
  defaults: { relevance_floor: 0.35, langs: [en], window_hours: 24 }
```

(Spaceflight is deliberately **not** a Newsflash lane — see §9.11.)

Source tiering still lives in `sources.yaml`, but for news lanes it weights
individual outlets *within* selection rather than choosing feeds. Selection is
rules-only: corroboration threshold + relevance floor + `interests.yaml`
negatives + recency sort. Summaries are the Newsflash canonical summary,
cleaned up — the LLM summarize stage stays off for these lanes.

**Gap-fillers by lane (RSS-direct, promoted only where Newsflash is thin):**

| Lane | Gap-filler sources | Why Newsflash alone is not enough |
|---|---|---|
| Tech / dev | Hacker News (Algolia API), Lobsters | Dev-depth discussion; Newsflash skews to press releases and launches |
| Science | EurekAlert | Press-release breadth |
| Math | arXiv math RSS/API, Quanta math, AMS Notices | Newsflash corpus has effectively nothing here — RSS-owned lane |
| Infrastructure | The B1M, New Civil Engineer, Global Construction Review | Trade-press depth; named-project tracking ("Ontario Line") |
| Canada / GTA | CBC, Star, Globe, BlogTO, Metrolinx/TTC notices | Hyperlocal GTA coverage Newsflash does not carry |

**Experiments.** Per-lane query tuning against the gold set: `min_sources` 2
vs 3, relevance floor (samples suggest ~0.35–0.40), negative-filter lists for
semantic drift (infrastructure matching AI/cloud/finance; tech product-launch
noise). `from`-window semantics: active-in-window vs first-seen-in-window.

**Open questions.** How old is too old for a lane item (24h hard cutoff, or recency decay)? Should the infrastructure lane alert on specific named projects from `interests.yaml`?

### 9.7 Holdings and earnings (portfolio watch)

**Shows.** A Holdings lane driven by `config/holdings.md`. Three things, in order of urgency: earnings dates over the next ~30 days (ticker, company, date, before or after close), results for earnings that landed in the last ~7 days (EPS and revenue against estimates, plus one line on guidance), and 3–5 important company news items tagged with their tickers as pills.

**Flows.** The holdings parser reads the markdown list on every run (list items only; headings and comments ignored) and resolves each line to a Yahoo symbol (decided — experiment 008): TSX → `.TO`, class shares dot→dash (`HMM.A` → `HMM-A.TO`), **NEO CDRs map to the underlying company via an explicit `cdr_map`** (`NEO:NVON` → `NVO`; prefix-stripping is wrong and 404s), bare tickers as-is (US-first), ETFs (CBIL, XEN, NLR) excluded entirely. **Yahoo Finance is the single source for this lane:** per-symbol news RSS for the important-company-news items (press releases flow through it — offerings, dividends, litigation) and `quoteSummary` (via `yahoo-finance2`, which automates the cookie+crumb handshake) for earnings dates with `isEarningsDateEstimate` flags and recent results with EPS surprise. Currency is labeled per item (`financialCurrency` — ATD reports USD, Novo Nordisk DKK, most TSX names CAD). Rows keep the user's ticker as the identifier but name the underlying company; thin-data micro-caps (HMM.A) render "no recent results" rather than stale rows. Promo/opinion pieces in the RSS feed are cut by rules (domain blocklist + title heuristics) before selection. Newsflash is **not** used here: its tradfi category proved issuer-blind and per-issuer queries are incomplete and false-positive-prone (experiment 008).

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| Yahoo Finance (news RSS + `quoteSummary` via `yahoo-finance2`) | **Chosen** (experiment 008): one source covers both jobs — complete news coverage of all 25 symbols and full earnings dates/results with surprise. Keyless except a crumb handshake the SDK automates. | Unofficial endpoints (no SLA — the SDK tracks breakage); promo/opinion pieces in RSS need rule cuts; micro-cap earnings history can be stale. |
| Newsflash (tradfi + per-issuer queries) | Already in-house. | **Rejected for this lane**: tradfi is issuer-blind (6 macro events/28d), per-issuer queries miss all small/mid-cap TSX names and false-positive on generic names (experiment 008). |
| Finnhub | Company news + earnings calendar, usable free tier. | US-centric; TSX coverage thin. Warm fallback if Yahoo degrades. |
| Alpha Vantage | Earnings calendar and news sentiment. | Heavily rate-limited free tier. |
| SEC EDGAR | Official US filings: 8-K earnings releases, guidance changes. Free full-text search. | US only (most of this portfolio is TSX), raw documents. |
| SEDAR+ / TMX Money | Canadian filings and TSX listings. | PDF-heavy, less structured. |
| Business Wire, PR Newswire, GlobeNewswire (RSS) | Primary earnings press releases. | High volume; per-symbol filtering needed — largely redundant with Yahoo's RSS which already carries them. |
| Bloomberg, Reuters, Financial Post, BNN Bloomberg | Tier-1 commentary. | Paywalls; headlines and deks only. |
| Nasdaq / MarketWatch earnings calendars | Cross-checking dates. | Scraping; dates still move. |

**Experiments.** Sources decided (experiment 008: fully Yahoo). Remaining: promo/opinion filter rules for the RSS feed (tune against the gold set); does Yahoo's `isEarningsDateEstimate` hold up vs. firm dates as they land; 30-day earnings horizon vs tighter; CDR display naming (underlying company vs "Costco CDR") in the UI density pass.

**Open questions.** Position sizes and price tracking are deliberately out of scope — this is a news and earnings watch, not a portfolio tracker — unless that changes by request. Should the morning digest mention same-day earnings?

### 9.8 Curation, dedupe, and the audit trail (cross-cutting)

**Shows.** The footer transparency line, plus a collapsed "Discarded today" view listing cut items with their scores and cut reasons, expandable per lane.

**Flows.** As in §7 and §8. The audit view reads `selections` rows where `picked = false`, joined to item titles and reasons ("relevance 0.31", "duplicate of cluster 42", "negative filter: crypto prices").

**Candidates.** Embeddings for cluster grouping: Gemini embedding (free tier), OpenAI or Voyage embeddings, or a local model via Ollama; alternatively skip embeddings and use SimHash + LLM tie-breaks only. News lanes need none of this — Newsflash clustering replaces embeddings there (see experiment 001).

**Experiments.** Are embeddings earning their cost and complexity over SimHash alone? How often does the LLM re-rank disagree with the rule score, and is the LLM right when it does (gold set)?

**Open questions.** How long to keep the audit trail (rolling 30 days is the default assumption)? Is a weekly "what got buried" digest useful?

### 9.9 Dashboard UI

**Shows.** The layout described in `style-guide.md`: masthead, morning digest, weather block, news lanes, Holdings, sports (Raptors first, one block per team), releases, upcoming launches (own section — §9.11), Reddit lanes, footer transparency line. Desktop-first, dark only.

**Flows.** Astro builds pages from the latest snapshot; a small client island handles refresh triggering, status polling, and the discarded-items toggle. Everything else is static HTML.

**Candidates.** Islands in vanilla TypeScript (default) or a light framework island if interactivity grows; hand-authored CSS with tokens (Tailwind with the same tokens is an alternative worth one experiment).

**Experiments.** Column layout for lanes (two news columns + rail vs single column + rail): build both in the preview and pick. How much can be static-generated vs needs live data.

**Open questions.** Should sections reorder by importance at build time (Raptors section jumps up on game days) or keep fixed order for familiarity?

### 9.10 Refresh, scheduling, and delivery

**Shows.** Status line in the masthead; runs and their cost live in the DB and a small "runs" debug view.

**Flows.** As in §4: three triggers, one pipeline entry point, `runs` logging, per-lane degradation.

**Candidates.** Node scheduler inside the daemon (`node-cron`-style) plus Windows Task Scheduler to start the daemon at login. If the daemon-on-login approach proves annoying, the fallback design is a Task Scheduler 09:00 task that runs `pnpm pipeline && pnpm build` and a static file server — a worse interactive experience but zero resident process.

**Experiments.** Is a resident daemon acceptable day to day (memory, startup, browser habit), or is on-demand better?

**Open questions.** Optional delivery beyond the page (ntfy/Telegram/system toast when the 09:00 run finishes) — deferred until the page itself is good.

### 9.11 Spaceflight: news + upcoming launches

**Shows.** Two shapes, kept apart deliberately (decided — experiment 007):
an **Upcoming launches** section — its own block, not mixed into news — with
the next few launches as date/time, vehicle + mission, pad + location,
status, and webcast flag; and the **spaceflight news lane**, 3–5 items of
headline + one-line summary + outlet, like the other news lanes.

**Flows.** Newsflash is **not** used for spaceflight. Two dedicated keyless
sources, both validated live (experiment 007):

1. **Spaceflight news** → `GET https://api.spaceflightnewsapi.net/v4/articles/`
   (note the base: the docs-site path `spaceflightnewsapi.net/api/v4/` 404s).
   Filters: `news_site` for specialist outlets (Spaceflight Now, SpaceNews,
   NASA, Ars Technica are all tracked among 42 sources), `search` terms from
   `interests.yaml`, `ordering=-published_at`. 36k+ articles, plus `/blogs`
   and `/reports` endpoints. The `summary` field is publication-quality
   one-liner material — rules-only summaries like the Newsflash lanes.
   Articles carry `launches[]` and `events[]` cross-links to Launch Library
   IDs, tying news to the launches section.
2. **Upcoming launches** → `GET https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=N&ordering=net`
   (Launch Library 2). Fields per launch: `name`, `net`, `window_start/end`,
   `net_precision`, `status` (Go/TBD), `pad` + location,
   `launch_service_provider`, `mission`, `webcast_live`, `vidURLs`, `image`,
   `probability`, `weather_concerns`. 450+ launches on the books. Only
   *upcoming* is wanted — no past-launch handling. Guest access is
   rate-limited; one request per run fits fine, and a free token lifts the
   ceiling if it ever bites.

**Data contract:**

| Data | Spaceflight News API | Launch Library 2 |
|---|---|---|
| News items | `title`, `url`, `summary`, `news_site`, `published_at`, `image_url` | — |
| Cross-links | `launches[]`, `events[]` (LL IDs) | `id`, `slug` |
| Launch schedule | — | `net` (time), `window_start/end`, `net_precision` |
| Mission | — | `name` (vehicle + mission string), `mission.description` |
| Place | — | `pad.name`, pad location |
| Status | — | `status.abbrev`/`description` (`Go`, `TBD`), `probability`, `weather_concerns` |
| Watching | — | `webcast_live`, `vidURLs` |

**Candidates.** None open for these two needs — both sources validated and
adopted. (General feed readers/RSS were the alternative; the structured
launch data is what rules them out for the launches section.)

**Experiments.** Launch-section scope: next 5 launches vs next 30 days?
Show `TBD` dates alongside `Go` ones (status as a column, presumably yes)?
Should a launch inside 48 h get promoted on the dashboard, the way the
Raptors section rises on game days? News-side query tuning (outlet filters
vs free-text) against the gold set.

**Open questions.** Should the news lane also cover the business/space-economy
angle (SpaceNews covers it), or stay flight-hardware focused?

### 9.12 Games: Steam wishlist sales (ITAD)

**Shows.** A Games lane: wishlist games currently **on sale** — title, shop, old price (struck), new price, % off — ranked by deepest cut then my wishlist priority. The username is config-driven (`games.steam_username: Bitesh9`).

**Flows.** Two-source chain (decided — experiment 012), everything but ITAD prices is keyless:

1. **Wishlist**: resolve the username → steamid64 (`steamcommunity.com/id/{user}?xml=1`, cached forever), then `IWishlistService/GetWishlist` → `[{appid, priority, date_added}]` (the `priority` field is the manual ordering — the sort key). The legacy `wishlistdata` endpoint is dead (returns the storefront).
2. **Identity + Steam price**: `api/appdetails` per appid → name, release date, price + discount %. Keyless; also the **fallback view** if ITAD is unavailable (Steam-only sale rows, and the lane says so).
3. **ITAD prices** (`POST /games/prices/v3`, `country=CA&currency=CAD`, `deals=true`): cross-shop sale view. **Sale semantics are universal-lowest** (verified — experiment 012): the row is the minimum `deals[].price` across *all* covered shops, shown with the winning `shop.name` — never shop-assumed — old price = that shop's `regular`, % off = `cut`; `historyLow`/`storeLow` give the "new historical low" context. One mapping step first: appids → ITAD UUIDs via the **keyless** bulk `POST /lookup/id/shop/61/v1`. Auth distinction (the trap): `prices`/`info` take the **API key** (`?key=` or `ITAD-API-Key` header) — not the OAuth client id/secret pair, which is for user-scope endpoints we don't use.

**Candidates.** ITAD is the named choice and the surface is mapped (403-on-missing-key probing pinned `POST /games/prices/v3`, `POST /games/overview/v2`, `GET /games/info/v2`; `/game/plain/v2`, `/search/v1`, `/service/game/v1` are dead paths). Steam's own `appdetails` covers Steam-store discounts only — kept as fallback. ITAD's native waitlist (OAuth, "in Waitlist" filter) is unnecessary since the Steam wishlist chain works keyless.

**Experiments.** Everything verified except the prices/v3 response shape (auth-gated). Remaining: historical-low flag behavior; how unreleased/no-price wishlist items render.

**Open questions.** Vouchers — include or keep to clean prices? Show the full wishlist (not-on-sale) collapsed, or sale rows only?

---

## 10. Suggested stack (defaults with alternatives)

| Layer | Default | Alternatives to try |
|---|---|---|
| Runtime | Node 22+, TypeScript, pnpm workspaces | Bun, Deno |
| Dashboard | Astro in Node standalone mode, vanilla TS islands | SvelteKit, Next.js, templated static HTML |
| Styling | Hand-authored CSS with custom properties from `style-guide.md` | Tailwind configured to the same tokens |
| Fonts | Self-hosted via Fontsource: Newsreader + IBM Plex Sans | Fraunces + Public Sans, Literata + Golos Text |
| Pipeline | TypeScript (`tsx`), same repo | Python for adapters that need `nba_api`/PRAW, called as a thin sidecar |
| Database | SQLite via `better-sqlite3` | Drizzle ORM or Kysely for typed queries; DuckDB if analytics ever matter |
| Validation | zod (config + LLM outputs) | — |
| HTTP / parsing | `fetch`/undici, `rss-parser`, `cheerio`, `pdf-parse` | Miniflux/FreshRSS as feed ingestion layer |
| News backbone | Newsflash REST API (plain `fetch`, bearer key from `.env`; OpenAPI spec published upstream) | RSS-direct per lane if Newsflash degrades |
| LLM access | Two providers (Google AI Studio OpenAI-shim + Backboard threads API), Vercel AI SDK optional | Direct provider SDKs |
| LLM models | Gemini 3.8 Flash (bulk, free tier) + GPT-5.6 Luna (interactive/fallback) | Gemini paid tier, larger GPT-5.6 tiers for hard judgment calls |
| Embeddings | Optional; Gemini embedding free tier or local via Ollama | Voyage, OpenAI embeddings |
| Scheduling | In-process scheduler + Windows Task Scheduler at login | Task Scheduler running the pipeline standalone |
| Testing | vitest + the eval harness (`pnpm eval`) | Playwright smoke test on the built page |

---

## 11. Repository layout

```
detox/
├─ AGENTS.md                # entry point for agents; maps the documents below
├─ config/
│  ├─ interests.yaml        # what you care about
│  ├─ holdings.md           # tickers for the Holdings lane (user-edited)
│  ├─ sources.yaml          # feeds, endpoints, tier weights, rate limits
│  ├─ models.yaml           # stage → model, mode, budgets
│  └─ settings.yaml         # lanes, budgets, caps, timezone
├─ packages/
│  ├─ core/                 # types, zod schemas, db access, config loader
│  ├─ adapters/             # weather/, nba/, reddit/, news/{newsflash, rss}/, finance/, spotify/, entertainment/
│  └─ llm/                  # client, stages, prompts/, budget guard
├─ apps/
│  ├─ dashboard/            # Astro app
│  └─ pipeline/             # runPipeline() entry, CLI, scheduler
├─ data/                    # gitignored: detox.db, snapshots/, cache/
├─ evals/                   # gold sets for selection, dedupe, summaries
└─ docs/
   ├─ architecture-plan.md  # this file
   ├─ style-guide.md
   ├─ anti-ai-design-decisions.md
   ├─ style-preview.html    # reference implementation of the style
   └─ experiments/          # decision records (see below)
```

Secrets (API keys, OAuth client credentials, provider keys) live in a single gitignored `.env`, loaded by `core`. Nothing else in the repo reads them directly.

---

## 12. Roadmap

**Phase 0 — Skeleton and style.** Repo, workspaces, SQLite schema, config loading, the daemon with the three refresh triggers against a stub pipeline, Astro shell rendering a snapshot, and the `style-guide.md` system implemented as tokens and components with fake data. *Exit: open localhost, see the fake dashboard, watch the stale-refresh contract work against a stub.*

**Phase 1 — Real data, rules only.** Weather (three sources + consensus), Reddit (official API), and one Newsflash news lane end to end through collect → normalize → dedupe (identity) → rule select → snapshot. *Exit: three lanes with real data and no LLM involved.*

**Phase 2 — LLM layer.** Provider clients, batching queue, per-provider budget guard, digest + taste stages, audit view, eval harness with a first gold set. *Exit: digest model-written with template fallback, taste scores measured against gold, Luna spend visible under $0.05 with Gemini usage against 30 RPD.*

**Phase 3 — Remaining features.** Raptors + injuries, Spotify + releases, the Holdings lane with earnings, the remaining news lanes. *Exit: every lane in the style preview backed by real data.*

**Phase 4 — Experiments and personalization.** Per-feature source trials from §9 (news backbone already decided in experiment 001; remaining work is per-lane query tuning), weather accuracy tracking, tier-weight tuning, prompt iteration against the gold set, optional feedback capture. *Exit: `docs/experiments/` holds a decision record per feature with data behind it.*

---

## 13. Experiment records

Every "which API do we use" decision lands in `docs/experiments/NNN-short-name.md`:

```markdown
# NNN — Choosing a weather source set

Status: decided 2026-10-12 | Revisit: 2027-01-01

## Question
Which 3–4 weather sources give independent, accurate-enough GTA forecasts?

## Candidates
Environment Canada (MSC GeoMet), Open-Meteo (GEM/ECMWF/GFS), MET Norway,
OpenWeatherMap.

## Method
Two weeks of parallel collection; compare each source's day-before high/low
and precipitation against observed values; measure inter-source spread.

## Result
…numbers…

## Decision
Environment Canada + Open-Meteo(ECMWF) + MET Norway. OpenWeatherMap dropped:
resold GFS, added no disagreement signal.

## Costs and limits
No keys needed. Worst-case latency 800 ms per call.
```

The eval harness (`pnpm eval`) provides the numbers for relevance and dedupe records; simple spreadsheets of observed-vs-forecasted are enough for weather.

---

## 14. Risks and open questions

- **Free-tier fragility.** Gemini free tier, Newsflash free tier, and Reddit API terms all change. The model layer and adapter layer are designed so any of them can be swapped in one file; keep the fallbacks warm. For news specifically, RSS gap-fillers can be promoted to backbone per lane without touching the pipeline.
- **Newsflash as a single point of dependency.** Most news lanes now flow through one hosted service. Mitigations: the `SourceAdapter` seam, per-lane RSS gap-fillers already identified, and raw event payloads stored in `raw_items` so a provider swap never loses history.
- **Windows sleep/hibernation** will silently eat the 09:00 run. The on-open rule is the safety net; a wake-aware scheduled task is a possible later refinement.
- **RSS feed rot.** Feeds move or die; the pipeline should treat a dead feed as a lane-stale condition and say so, not fail silently.
- **Prompt drift.** Without the eval harness, "relevant to me" quietly gets worse with every tweak. The harness ships in Phase 2, before prompt tuning starts.
- **Scope creep toward kitchen sink.** The 3–5 item budget is a design constraint, not a default. If a lane feels thin, the fix is better selection or better sources, not more items.
- **Earnings data quality.** Dates get moved (11 of 25 are Yahoo "estimated" dates right now), and micro-caps can carry stale history (HMM.A showed a 2010 row). The lane must label its source and as-of time, flag estimated dates, and cross-check before showing them.
- ~~Ticker noise.~~ Largely resolved by experiment 008: Yahoo's per-symbol feeds carry no name-matching step, so word-collision problems (the "ALL"/"ARE" class) don't arise. Residual risk is promo/opinion content inside the per-symbol feed, handled by rule cuts before selection.
- **Unresolved from the Q&A:** LLM stage set (summarize / dedupe / select / rank / explain) stays configurable per stage until the gold set says which earn their cost; digest paragraphs optional; push delivery deferred; concerts and other leagues out of scope for now.
