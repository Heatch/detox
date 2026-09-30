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
| LLM access | Router/provider-agnostic layer (Backboard.io as the router; any OpenAI-compatible provider behind it). |
| Model strategy | Gemini 3.8 Flash free tier for bulk daily work (5 requests/min — batch hard), GPT-5.6 Luna for interactive and fallback work. Per-stage model config, swappable. |
| LLM spend | Target ≈ $0.05/day soft cap, enforced by a budget guard; the pipeline degrades to rules-only rather than overspending. |
| LLM role | Not fixed. Every LLM stage is pluggable per feature; rules-first, LLM-second everywhere so each stage can be enabled, disabled, or swapped independently. |
| Curation | Small number of strong, well-sourced items. Selection budget of 3–5 items per topic lane. Everything discarded is retained and reviewable, never silently lost. |
| Personalization | `config/interests.yaml` — keywords, topics, entities, teams, watchlist, negative filters. |
| Connected accounts | Spotify (followed artists → music releases), Reddit (official OAuth app). More later if needed. |
| Reddit access | Official API app (OAuth), RSS as fallback, both behind the adapter interface. |
| News presentation | Headlines + one-line summaries, grouped by topic lane, source always named. |
| Weather | Multiple independent sources, shown side by side with a computed consensus and a note when they disagree. |
| Sports | Raptors-first, plus NBA league context where it helps. |
| Holdings | Tickers from `config/holdings.md` (a markdown list, Canadian and US). A Holdings lane shows important company news, upcoming earnings dates, and results for earnings that just landed. |
| Typography | Serif headlines and summaries, quiet sans for controls and metadata. |
| Colour | Deep slate canvas, warm off-white ink, muted gold accent. Dark only. |

Deliberately left open: every specific API/SDK choice, LLM prompt design, which LLM stages stay on, news feed lists, and how many sources weather settles on.

---

## 2. Design principles

1. **Local-first and yours.** Data, keys, and history live on your machine in one SQLite file. Nothing phones home except the source APIs and the LLM router.
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
   │  nba/  entertainment/  news/{rss, aggregator…}  finance/ │
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
  id: string;                 // hash of canonical URL (stable identity)
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

A lane is a named slice of the page with a selection budget and a sort policy: `tech`, `science`, `math`, `infrastructure`, `canada-gta`, `spaceflight`, `holdings`, `raptors`, `releases`, `reddit-nba`, `reddit-uwaterloo`, `weather`. Lanes are configured, not hardcoded; adding one should be config plus at most one adapter.

### 5.4 InterestConfig (`config/interests.yaml`)

```yaml
topics:
  infrastructure:
    keywords: [tunnel boring, high-speed rail, gigafactory, grid interconnect]
    entities: [Crossrail, Brightline, Ontario Line]
    weight: 1.2
teams: [Toronto Raptors]
watchlist:
  shows: [The Long Corridor]
  movies: [Salt Flats]
music:
  use_spotify_follows: true
  artists: [Halcyon Fields]          # plus Spotify follows
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
| `items` | Normalized `CanonicalItem` rows. |
| `clusters`, `cluster_items` | Dedupe clusters; a headline seen by five outlets is one cluster of five items. |
| `selections` | Per run, per lane: item picked or cut, rule score, LLM score, rationale, summary. Cut rows are the audit trail. |
| `weather_forecasts` | Per run, per source: issued time, high/low, precip probability and amount, wind, raw payload. |
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
3. **Dedupe.** Cheap first: canonical URL equality, normalized-title equality, SimHash over title+dek. Then, only for near-misses, optional embedding similarity to group clusters. Finally one batched LLM call reviews ambiguous cluster pairs and returns merge/split decisions. The merge decision is stored, so identical stories cost nothing tomorrow (content-hash cache).
4. **Select.** Rule score first: recency decay, source tier, keyword and entity hits from `interests.yaml`, engagement percentile, cluster size (many outlets covering it is a signal), negative-filter penalty. Then one batched LLM call per lane re-ranks the top ~25 candidates and returns 3–5 picks with a short rationale each. The rule score and LLM score are both stored so disagreements are visible.
5. **Summarize.** One line per selected item (≤ 25 words), naming the source and stating uncertainty plainly. Optional one-paragraph lane digest, off by default until its value is proven. Also one batched call.
6. **Assemble.** Build the snapshot: lanes, items, rationales, transparency counts (collected, merged, shown, cut), weather consensus (median of sources, arithmetic — no LLM), sports blocks, cost totals.

**Budget guard.** Before each stage, estimate tokens; track today's spend in `llm_calls` against `daily_cap_usd` (default 0.05). Over cap → summary and re-rank stages switch to rules-only and the footer says so. Under the Gemini free tier the estimate is still tracked, so switching to a paid model later needs no code change.

**Caching.** `hash(stage version + item content)` → stored output. Unchanged content is never re-sent to a model. This is what makes the 5 requests/min limit painless.

---

## 8. LLM layer

**Routing.** All calls go through one `LlmClient` that speaks the router's OpenAI-compatible API (Backboard.io today, any compatible endpoint by changing a base URL and key). `config/models.yaml` maps stages to models:

```yaml
stages:
  select:      { model: gemini-3.8-flash, mode: llm }
  summarize:   { model: gemini-3.8-flash, mode: llm }
  dedupe:      { model: gpt-5.6-luna,     mode: llm }
  digests:     { model: gemini-3.8-flash, mode: off }
```

**Model guidance (checked against published pricing, September 2026):**

- **Gemini 3.8 Flash (free tier)** — input and output free of charge, capped at 5 requests/min and 1M-token input context. Thinking tokens bill as output only on paid tiers. Perfect for the daily bulk if calls are batched and the pipeline is patient. Caveats: the free tier's terms can change, introductory paid pricing ($0.75/$3.75 per 1M) doubles on 2027-01-01, and 5 RPM shapes the pipeline more than the price does.
- **GPT-5.6 Luna** — $0.20/$1.20 per 1M standard, $0.10/$0.60 batch, $0.02 cached input, 500 RPM, ~1M-token context. At those rates the $0.05/day target buys on the order of 250K input plus 40K output tokens uncached, and far more with cache hits. Ideal for interactive calls, retries when Gemini throttles, and the dedupe reviewer.

**Working the 5 RPM limit:**

- Batch 20–60 items per call (both models have ~1M context; a lane's candidates fit easily).
- Token-bucket queue at 4 requests/min with exponential backoff; throttled work is queued and resumed, never restarted.
- Route interactive and on-demand paths to Luna so the page never waits on the throttle.
- Cache aggressively (content hash + prompt version) so a second run over the same items costs zero calls.

**Structured outputs.** Every stage returns JSON validated by its zod schema; invalid output is retried once with the validation error, then falls back to rules-only for that lane.

**Eval harness.** `evals/gold.jsonl` holds labeled items (relevant/not, duplicate-of, summary quality). `pnpm eval` runs the current prompts against it and reports precision@k for selection, dedupe accuracy, summary drift, and cost per run. Prompt changes run the harness before they land. This is how "does the LLM actually know what's relevant to me" gets answered with data instead of vibes.

**Degradation ladder.** Router unreachable → rules-only selection using source deks as summaries. One model throttled → retry queue, then swap to the fallback model for that stage. Over budget → summaries off, selection rules-only. The dashboard always renders; it always says which of these is active.

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

**Shows.** Side-by-side per-source forecasts for the GTA: high, low, precipitation probability and amount, wind, plus a 7-day strip. A consensus row (median across sources) in accent colour and a plain-language note when spread is notable ("sources disagree on rain: 40–60% chance").

**Flows.** Each weather adapter stores its own forecast row per run; consensus is computed arithmetically (median per metric, spread = max − min); the disagreement note is templated, not LLM-written. Historical runs enable accuracy tracking later.

**Candidates (verify current terms before committing):**

| Candidate | Why it's a candidate | Watch out for |
|---|---|---|
| Environment Canada / MSC GeoMet (`api.weather.gc.ca`) | The official Canadian source, no key, plus radar via GeoMet. | Documentation quality, station coverage. |
| Open-Meteo | No key, and lets you request several models (GEM, ECMWF IFS, GFS, ICON) separately — genuinely independent opinions. Also has a historical-forecast API for scoring accuracy. | It aggregates, so "Open-Meteo says" may mean "one of its models says". |
| MET Norway (yr.no) | Free with a proper user agent, strong global forecasts, independent model provenance (ECMWF-based). | Rate limits and etiquette rules. |
| NWS (`api.weather.gov`) | Free, official US, model-diagnostic discussions. | US only; useful only for travel. |
| OpenWeatherMap / WeatherAPI.com / Tomorrow.io / Pirate Weather | Private-sector fourth opinions with easy keys. | Free-tier caps, less Canadian tuning. |

**Experiments.** Which 3–4 sources give genuinely independent disagreement (not just re-sold GFS output)? Does the consensus beat any single source over a month? What spread threshold makes the disagreement note worth showing (temperature ≥ 3 °C? precipitation probability ≥ 25 points?)?

**Open questions.** Hourly detail or daily only? Include radar image snapshots (GeoMet tiles) or keep it typographic?

### 9.3 Raptors (schedule, injuries, results) with NBA context

**Shows.** Next game block (date, opponent, time, venue, broadcast), a compact injury table (player, status, note, as-of), last result, and one line of league context (standing, notable news item from the news lanes).

**Flows.** Dedicated `nba` adapters normalize schedule, results, and injuries into `games` and `injuries` rows; injuries carry source and as-of timestamps because they change constantly. Injury text is not LLM-written — it's structured data; the LLM may only pick which league-context news item to surface.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| ESPN's site API (public JSON endpoints for scoreboard, team schedule, injuries) | No key, structured, reliable for schedule/scores/injuries. | Undocumented; can change without notice. |
| NBA.com stats endpoints (via `nba_api` Python SDK, or direct REST) | The official data; richest box scores and standings. | Fragile headers, rate limiting, Python-first SDK in a TS repo. |
| NBA official injury report (published as PDF) | The source other sites copy. | PDF parsing (`pdf-parse`) and twice-daily publication times. |
| Rotowire / NBC Sports injury pages | Faster human-curated injury notes. | Scraping, and they're derivative sources. |
| Basketball Reference | Historical depth, sanity checks. | Scraping and rate limits. |
| TSN / Sportsnet unofficial endpoints | Canadian broadcast info. | Unofficial and brittle. |

**Experiments.** Which source carries injury news first on game days? Is PDF parsing of the official report reliable enough for the injury table, or is ESPN's digest enough? How should the section behave on non-game days (collapse to a one-liner)?

**Open questions.** Preseason and Summer League coverage — on or off? How much NBA context is useful without becoming an NBA news lane?

### 9.4 Entertainment releases (TV, film, music)

**Shows.** "Coming up" over the next 30–60 days: rows of date, title, kind (album, single, TV, film), and where it lands (theatre, streaming service, platform). Music relevance comes from Spotify follows plus `interests.yaml`; screen relevance from the config watchlist.

**Flows.** Entertainment adapters write `releases` rows keyed by (kind, title, date) to dedupe album-vs-single and regional date noise. Relevance is config-driven first (exact title and artist matching), LLM optional for fuzzy matching of "you might also like" — which is explicitly out of scope until the basics are right.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| Spotify Web API (OAuth, your account) | Followed artists' new releases, album vs single, exact dates. The planned music connection. | Release dates can be placeholder/wrong in Spotify metadata. |
| TMDB (free API key) | Movies and TV with Canadian `release_dates`; watchlist via OAuth or a manual list. | Region quirks; theatrical vs streaming dates differ. |
| Trakt (OAuth) | Watchlist plus a proper calendar endpoint. | Requires an account you said you don't want yet; revisit later. |
| TVmaze (free, no key) | Simple TV schedule by date and country. | Less metadata than TMDB. |
| MusicBrainz + Cover Art Archive | Open data, no account, good for cross-checking music dates. | Sparse on upcoming releases. |
| Watchmode | Unified streaming release dates. | Key + free-tier limits. |
| Bandsintown / Songkick | Concerts for followed artists, if that turns out to matter. | Another account and key. |

**Experiments.** Where do music release dates actually hold up (Spotify vs MusicBrainz vs announcement coverage)? TMDB vs TVmaze for Canadian streaming dates. Is "coming up" better as a list or a small calendar strip?

**Open questions.** Do concerts belong here or in their own lane? Do you want "out today" highlighted or is forward-looking enough?

### 9.5 Reddit (r/nba, r/uwaterloo)

**Shows.** Per subreddit: 3–5 posts with title, a one-line summary where the thread is substantive, and tabular score and comment counts. Game threads and spoilers filtered by config. Links go to the thread.

**Flows.** Reddit adapter fetches listings (hot/top for the window) plus top comments for threads that pass a first relevance cut. Summaries are LLM-written over title + top comments in one batched call; low-comment posts skip summarization entirely and just show the title. Config `subreddits` list makes adding r/toronto trivial.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| Official Reddit API (OAuth app on your account) | The chosen path; stable-ish within rate limits. | App registration, OAuth refresh handling, rate limits; API terms on caching and attribution. |
| PRAW (Python) | Excellent SDK for the official API. | Python in a TS repo — fine if the pipeline leans Python, otherwise do the OAuth flow directly over fetch. |
| RSS (`.rss` endpoints) | Keyless fallback for titles and links. | No scores, no comments, no summaries. |
| Unofficial `.json` endpoints | Rich and keyless. | Can break or block without warning; fallback only. |
| Arctic Shift / PullPush | Historical search if you later want "what did r/nba say last week". | Third-party archives; data quality varies. |

**Experiments.** Does summarizing top comments add value over the title alone? What's the smallest comment count where a thread deserves a summary? Rate-limit headroom with two subreddits plus comment fetches.

**Open questions.** Should r/uwaterloo get its own lane or share a "Reddit" lane with subreddit tags? How are game threads handled — pinned in the Raptors section, hidden, or collapsed?

### 9.6 News lanes (tech, science, math, infrastructure, Canada/GTA, spaceflight)

**Shows.** Per lane: 3–5 items as headline + one-line summary + outlet and age. Cross-lane dedupe means one story appears in one lane only, with its cluster size visible in the audit view.

**Flows.** The news backbone is RSS plus one or two aggregators feeding the shared collect → normalize → dedupe → select path. Source tiering lives in `sources.yaml` (tier 1: primary outlets and specialist press; 2: general press; 3: aggregators and aggregators-of-aggregators), and tier feeds rule scoring. Google News-style query feeds are breadth insurance, heavily demoted by tier so they fill gaps rather than set the agenda.

**Candidates by lane:**

| Lane | Candidate sources |
|---|---|
| Tech / dev | Hacker News (Algolia API), Lobsters, Ars Technica, The Verge, InfoQ, official project changelogs. |
| Science | Nature news RSS, ScienceDaily, Phys.org, EurekAlert, Quanta Magazine. |
| Math | arXiv math RSS/API (new and cross-listed), Quanta math coverage, AMS/Notices feeds, MathOverflow digest threads. |
| Infrastructure | The B1M, New Civil Engineer, Railway Technology, Global Mass Transit, Global Construction Review, ENR (paywall — headlines only), plus query feeds for megaproject keywords from `interests.yaml`. |
| Canada / GTA | CBC (Toronto) RSS, Toronto Star, Globe and Mail, CTV, CityNews, BlogTO, NOW Toronto, Metrolinx and TTC capital project notices, optionally r/toronto. |
| Spaceflight | NASA news RSS, Spaceflight Now, Ars Technica space, NASASpaceflight, Everyday Astronaut, plus Launch Library 2 for upcoming launches as structured data. |
| Cross-cutting | Google News RSS query feeds (`when:1d`, region ca), NewsAPI.org, GNews, NewsData.io, TheNewsAPI — all key-gated candidates for breadth experiments. |

**Aggregator option.** A self-hosted Miniflux or FreshRSS instance as the ingestion layer is a real candidate: it handles feed health, polling, and dedupe-free storage, and the pipeline reads its API instead of fifty feeds directly. Trade-off: another service to run on the machine. Worth testing against direct `rss-parser` fetching.

**Experiments.** Query-feed noise vs curated feed lists per lane (measure precision@5 against the gold set). Does tier-weighted rule scoring get close enough that the LLM re-rank is optional? Which lanes actually need the LLM — math may be perfectly served by rules, infrastructure may need it badly. Feeds per lane: minimum viable set.

**Open questions.** How old is too old for a lane item (24h hard cutoff, or recency decay)? Should the infrastructure lane track specific named projects from `interests.yaml` and alert on them ("Ontario Line")?

### 9.7 Holdings and earnings (portfolio watch)

**Shows.** A Holdings lane driven by `config/holdings.md`. Three things, in order of urgency: earnings dates over the next ~30 days (ticker, company, date, before or after close), results for earnings that landed in the last ~7 days (EPS and revenue against estimates, plus one line on guidance), and 3–5 important company news items tagged with their tickers as pills.

**Flows.** The holdings parser reads the markdown list on every run (list items only; headings and comments ignored), normalizes tickers exchange-aware (`TSX:SHOP` and `SHOP.TO` are the same company in different data sources), and resolves company names and exchange identifiers where the file omits them. Finance adapters produce two kinds of rows: structured `earnings_events`, and `items` in the `holdings` lane carrying `tickers: []`. Dedupe matters twice: one wire story often covers several holdings (one cluster, multiple tickers), and earnings coverage repeats across every outlet within an hour. Selection leans on source tier harder here than anywhere else — filings and wire services over commentary — because promotional financial content is the dominant noise in this lane.

**Candidates:**

| Candidate | Why | Watch out for |
|---|---|---|
| Yahoo Finance (via `yahoo-finance2` or the unofficial endpoints) | Quotes, earnings dates, and news for both US and TSX listings in one place. | Unofficial; earnings dates drift and Yahoo's are often stale. |
| Finnhub | Company news and an earnings calendar with a usable free tier. | US-centric; TSX coverage is thin. |
| Alpha Vantage | Earnings calendar and news sentiment. | Free tier is heavily rate-limited per day. |
| Polygon.io / Financial Modeling Prep | Solid fundamentals and earnings data if a paid tier ever makes sense. | Cost; overkill for a morning watch. |
| SEC EDGAR | Official US filings: 8-K earnings releases, guidance changes. Free full-text search. | US only, and filings are raw documents. |
| SEDAR+ / TMX Money | The Canadian equivalents: filings and TSX listings. | PDF-heavy, less structured. |
| Business Wire, PR Newswire, GlobeNewswire (RSS) | Earnings press releases are the primary source and the first to carry results. | High volume; needs per-ticker filtering. |
| Google News query feeds per company | Breadth and Canadian coverage in one mechanism. | Ticker-word collisions ("ALL", "ARE", "IT"): query by company name plus ticker, then verify the ticker tag after the fact. |
| Bloomberg, Reuters, Financial Post, BNN Bloomberg | Tier-1 commentary and analysis worth surfacing. | Paywalls; headlines and deks only. |
| Nasdaq / MarketWatch earnings calendars | Cross-checking dates before they land in the lane. | Scraping, and dates still move. |

**Experiments.** Which source's earnings dates actually hold up (they get moved, especially for TSX names)? Can recent results be parsed from the wire press release instead of a fundamentals API? How badly does query-based news degrade for short tickers, and does tag-after-fetch fix it? Does one story covering two holdings dedupe cleanly across tickers?

**Open questions.** Windows: 30 days ahead and 7 days back is the starting assumption. Position sizes and price tracking are deliberately out of scope — this is a news and earnings watch, not a portfolio tracker — unless that changes by request. Should the morning digest mention same-day earnings?

### 9.8 Curation, dedupe, and the audit trail (cross-cutting)

**Shows.** The footer transparency line, plus a collapsed "Discarded today" view listing cut items with their scores and cut reasons, expandable per lane.

**Flows.** As in §7 and §8. The audit view reads `selections` rows where `picked = false`, joined to item titles and reasons ("relevance 0.31", "duplicate of cluster 42", "negative filter: crypto prices").

**Candidates.** Embeddings for cluster grouping: Gemini embedding (free tier), OpenAI or Voyage embeddings, or a local model via Ollama; alternatively skip embeddings and use SimHash + LLM tie-breaks only.

**Experiments.** Are embeddings earning their cost and complexity over SimHash alone? How often does the LLM re-rank disagree with the rule score, and is the LLM right when it does (gold set)?

**Open questions.** How long to keep the audit trail (rolling 30 days is the default assumption)? Is a weekly "what got buried" digest useful?

### 9.9 Dashboard UI

**Shows.** The layout described in `style-guide.md`: masthead, morning digest, weather block, news lanes, Holdings, Raptors, releases, Reddit lanes, footer transparency line. Desktop-first, dark only.

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
| LLM access | Router via OpenAI-compatible API (Backboard.io), Vercel AI SDK optional | Direct provider SDKs (Google AI, OpenAI) |
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
│  ├─ adapters/             # weather/, nba/, reddit/, news/, finance/, spotify/, entertainment/
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

Secrets (API keys, OAuth client credentials, router key) live in a single gitignored `.env`, loaded by `core`. Nothing else in the repo reads them directly.

---

## 12. Roadmap

**Phase 0 — Skeleton and style.** Repo, workspaces, SQLite schema, config loading, the daemon with the three refresh triggers against a stub pipeline, Astro shell rendering a snapshot, and the `style-guide.md` system implemented as tokens and components with fake data. *Exit: open localhost, see the fake dashboard, watch the stale-refresh contract work against a stub.*

**Phase 1 — Real data, rules only.** Weather (three sources + consensus), Reddit (official API), and one news lane end to end through collect → normalize → dedupe (lexical) → rule select → snapshot. *Exit: three lanes with real data and no LLM involved.*

**Phase 2 — LLM layer.** Router client, batching queue, budget guard, selection and summarization stages, audit view, eval harness with a first gold set. *Exit: lanes curated to 3–5 strong items with rationales and a visible daily cost under $0.05.*

**Phase 3 — Remaining features.** Raptors + injuries, Spotify + releases, the Holdings lane with earnings, the remaining news lanes. *Exit: every lane in the style preview backed by real data.*

**Phase 4 — Experiments and personalization.** Per-feature source trials from §9, weather accuracy tracking, tier-weight tuning, prompt iteration against the gold set, optional feedback capture. *Exit: `docs/experiments/` holds a decision record per feature with data behind it.*

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

- **Free-tier fragility.** Gemini free tier and Reddit API terms both change. The model layer and adapter layer are designed so either can be swapped in one file; keep the fallbacks warm.
- **Windows sleep/hibernation** will silently eat the 09:00 run. The on-open rule is the safety net; a wake-aware scheduled task is a possible later refinement.
- **RSS feed rot.** Feeds move or die; the pipeline should treat a dead feed as a lane-stale condition and say so, not fail silently.
- **Prompt drift.** Without the eval harness, "relevant to me" quietly gets worse with every tweak. The harness ships in Phase 2, before prompt tuning starts.
- **Scope creep toward kitchen sink.** The 3–5 item budget is a design constraint, not a default. If a lane feels thin, the fix is better selection or better sources, not more items.
- **Earnings data quality.** Dates get moved, estimates vary by provider, and TSX coverage is thinner than US coverage across every candidate. The lane must label its source and as-of time, and cross-check dates before showing them.
- **Ticker noise.** Short tickers collide with ordinary words in query-based news search, and one story often touches several holdings. Both are handled by tagging after fetch and cross-ticker dedupe, but expect the gold set to grow examples here.
- **Unresolved from the Q&A:** LLM stage set (summarize / dedupe / select / rank / explain) stays configurable per stage until the gold set says which earn their cost; digest paragraphs optional; push delivery deferred; concerts and other leagues out of scope for now.
