# 001 — Newsflash as the primary news source

Status: decided 2026-09-30 | Revisit: 2027-01-01 (or sooner if free-tier terms change)

## Question

Can one service replace the planned RSS-plus-aggregator news backbone for the
tech, science, math, infrastructure, Canada/GTA, and spaceflight lanes —
including dedupe, trust signals, and item summaries — without an LLM in the loop?

## Candidates

- **Newsflash (newsflash.sh)** — hosted deduped event graph over 265 outlets:
  one event per happening with canonical title, summary, corroborating sources,
  `confidence = min(1, source_count / 3)`, stable event IDs, REST + MCP + SSE + CLI.
- RSS-direct via `rss-parser` (dozens of per-lane feeds).
- Self-hosted Miniflux/FreshRSS as ingestion layer.

## Method

Live probing on 2026-09-30 in two rounds:

1. Keyless exploration (test tier: 50 req/day, 24 h lookback) — corpus stats,
   source list, and real past-24 h events for tech, science, math,
   infrastructure, Canada, and Toronto/GTA queries, plus event-detail and
   `min_sources=3` filtering checks.
2. Keyed verification (free tier) — `GET /api/me` for tier and quota, plus a
   historical query (`from=2026-09-10`, `to=2026-09-11`) to confirm the 30-day
   lookback serves unclamped results. Total spend: ~15 requests.

## Result

**Account and limits (verified with key).** `GET /api/me` returns
`tier: free, limit: 1000, used_today: 1`. Response headers confirm
`tier: free`, `lookback-days: 30`, `limit: 1000`. The 20-day-old historical
query returned 5 events with no `window` clamping object. A full morning run
needs on the order of 15 requests — the free tier has ~65x headroom.

**Corpus (observed).** 265 sources, ~1.5M articles, last ingest minutes old.
Categories: `world` (156), `tech` (29), `tradfi` (18), `crypto` (18),
`business` (10), `politics` (9), `science` (9), `energy` (6), `health` (6),
`sports` (5). No math, infrastructure, or Canada category — those lanes are
query-driven. Six Canadian outlets tracked (CBC, CTV, Global, Financial Post,
2x MINING.com), all national. Science sources include Nature, Quanta,
Phys.org, ScienceDaily, NASA, NYT Science.

**Lane-by-lane sample results (past 24 h, real events):**

- Tech (`category=tech`, `min_sources=3`): Dutch police ShinyHunters arrest
  (14 sources, conf 1.0), Florida AG vs OpenAI (7), Chinese AI bioweapons tool
  (3), plus product-launch noise (Fire TV, DoorDash-by-text, SmartTag).
  Corroboration counts outlets, not importance — ranking still needs rules.
- Science: genuinely good, ~10 events/24 h. Butterfly optical illusions (3:
  Nature + CNA + Phys.org), feathered dinosaur fossil (3), AI-protein
  watermarking (2), Asgard archaea motility (2), wolverine decline in the
  Canadian Rockies (2).
- Math: effectively empty. Best semantic hits were AI-and-math commentary
  (relevance ≤ 0.45), no real results. Needs arXiv/Quanta RSS regardless.
- Infrastructure (semantic query, best surprise): LNG Canada Phase 2 approved
  in Kitimat B.C. (3), $6bn data-centre commitments (5), Brisbane 2032 stadium
  frontrunner (3), North Korea–Russia/China bridges (3), Delhi traffic system
  (2), London flyover works (2). Drift caveat: "infrastructure" also matches
  AI/cloud/financial infrastructure — needs negative filters.
- Canada (`q=Canada` keyword): solid at national level — US ban on $1bn of
  Canadian goods (2), Quebec separatists near power (2), BoC deputy on the
  trade-war dilemma (2), LNG Canada (3). GTA hyperlocal is a gap: semantic
  search is theme-blind to geography (Toronto transit/housing returned Sydney
  buses and Singapore rebates), `q=Toronto` skewed to sports, `source=cbc`
  returned zero events.
- Event detail (`GET /api/events/:id`): full corroborating-article list with
  per-outlet title, URL, and summary. The 14-source ShinyHunters event spans
  Krebs, BleepingComputer, The Verge, TechCrunch, CTV, NOS, and others.

**Quirks found (all handleable client-side):**

- No `lang` filter param; German/French/Portuguese titles leak into English
  queries. Workaround: drop non-English-only events using `sources[].lang`.
- Occasional `null` summary; live-blog summaries with emoji; HTML entities in
  titles (`&#8216;`). Cleanup pass required in the adapter.
- `from` filters events *active* in the window, not *first seen* in it (a
  35 h-old story with fresh articles still shows). Arguably right for a
  morning briefing, but the adapter must sort by `first_seen_at` + recency
  itself rather than trusting response order (default order is not importance).
- Same event ID across two lane queries = free cross-lane dedupe.

## Decision

**Lock in Newsflash as the primary news backbone.** Per-lane query specs live
in `config/sources.yaml` as `{q, semantic, category, min_sources,
relevance_floor, langs: [en]}`. RSS drops to gap-filler duty:

| Lane | Newsflash query | Gap-filler (RSS-direct) |
|---|---|---|
| Tech / dev | `category=tech`, `min_sources=2–3` + keyword queries from `interests.yaml` | HN (Algolia API), Lobsters for dev depth |
| Science | `category=science`, `min_sources=2` | EurekAlert for press-release breadth |
| Math | — (corpus has nothing) | arXiv math RSS/API, Quanta, AMS Notices — RSS-owned lane |
| Infrastructure | semantic theme queries + named-project keywords ("Ontario Line") | B1M, NCE, GCR for trade-press depth |
| Canada / GTA | `q=Canada` keyword + outlet queries | CBC/Star/Globe/BlogTO/Metrolinx RSS for hyperlocal |
| Spaceflight | keyword + semantic queries | Launch Library 2 for structured launch dates |

News-lane LLM stages default to `rules-only`/`off`: selection is
corroboration threshold + relevance floor + negative filters + recency sort,
and the Newsflash canonical summary (cleaned up) is the one-line summary.
LLM budget is reserved for the morning digest and taste-level tiebreaks.
`CanonicalItem.id` for news items is `nf:<event_id>`.

## Costs and limits

- Free tier: 1,000 req/day, 30-day lookback, 2 streams. Key lives in `.env`
  as `NEWSFLASH_API_KEY`, sent as `Authorization: Bearer nf_…`.
- Morning run ≈ 15 requests. No SDK needed — plain `fetch` against the REST
  API (OpenAPI 3.1 spec published in their repo for typed clients).
- Adapter requirements: bearer auth, ETag/conditional requests, client-side
  language filter, HTML-entity decoding, null-summary fallback to first
  corroborating article dek, sort by confidence + recency.
- Single-point-of-dependency risk: mitigated by the `SourceAdapter` seam —
  RSS gap-fillers can be promoted to backbone per lane without touching the
  pipeline. Revisit if free-tier terms change.

## Follow-ups

- Per-lane query tuning against the eval gold set: `min_sources` threshold
  (2 vs 3), relevance floor (samples suggest ~0.35–0.40), negative-filter lists
  (especially infrastructure drift and tech product-launch noise).
- Decide `from`-window semantics: active-in-window vs first-seen-in-window.
- Re-test `source=cbc` (returned zero under the test tier) with the key.
- Premium 5-year archive is of interest for one thing only: backtesting query
  tuning against history.
