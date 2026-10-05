# 011 — TV: new seasons from seen shows + LLM-scored new shows

Status: decided 2026-10-04 (TMDB TV live; seasons + gated taste scoring implemented in 3D) | Revisit: 2027-01-01

## Question

TV half of the release lane, split from movies (different volume, different
problem). Requirements from the brief:

1. Config list of **all shows previously seen** → upcoming releases for their
   **new seasons** (no filtering — they're already-liked shows).
2. **New shows**: build a confidence score for "how much would I like this"
   with an LLM (or something else/combination). Show only shows that are
   **very, very popular/anticipated OR pass a confidence threshold**.
3. TMDB if possible, else another source.

## Method

Live probes 2026-09-30 (TMDB key in `.env`): new-season signal shapes across
known returning shows, the new-shows window under filters, premiere
detection, trend-anticipation check, and the per-show metadata available for
taste scoring.

## Result

**TMDB handles the data; the LLM question resolves to "combination".**

**New-season detection — `seasons[]` is the signal, not `next_episode_to_air`.**
Verified shapes on real shows:

- **Dated premiere** (the row to render): `next_episode_to_air` with
  `episode_number == 1` — e.g. Law & Order SVU S28E1 on 2026-10-08, NCIS
  S24E1 on 2026-10-06, Grey's Anatomy S23E1 on 2026-10-15.
- **Undated announcement**: `seasons[]` tail with `air_date: null,
  episode_count: 0` — Severance S3, Wednesday S3, Last of Us has no S3 row
  yet. `next_episode_to_air` is **empty** for these (and for most returning
  shows), so a design built on it alone would show nothing for the biggest
  shows on the list. Row: "Season 3 announced, no date yet".
- **Mid-season continuation** (not a premiere): Slow Horses S6E3 today —
  presumably out of scope ("new seasons", not "new episodes") but available
  if wanted later.
- Ended shows (The Bear, status `Ended`) correctly yield nothing.

**New shows window** (2026-09-30 → 2026-11-29): 413 raw → **98 with
`with_original_language=en`**. TV popularity is on a **much smaller scale
than movies**: max 20.3, p90 17.3, median 10.2 (movie windows hit 200+).
Thresholds must be TV-calibrated. `trending/tv/week` is useless as an
anticipation signal — 0 of 20 items were unaired (trending tracks viewing,
not announcements). Dead end, dropped.

**Taste-scoring inputs — abundant.** Per show, one
`/tv/{id}?append_to_response=credits` gives genres, networks, `created_by`,
top cast, overview, popularity. From the seen-shows list that yields a taste
profile: genre histogram, favorite creators, networks, and the titles
themselves as direct LLM context.

## Decision

**TMDB for TV. Three tiers in one lane:**

1. **Seen shows → new seasons (always shows).** `config/interests.yaml`
   `tv.seen_shows` (titles; resolved via `/search/tv`, IDs cached — watch
   name ambiguity like "The Office" US vs UK, resolution helper picks by
   popularity+first_air_date and can be pinned). Per show: scan `seasons[]`
   for `season_number` beyond the last aired. Dated future season →
   "Season N, starts <date>". Null `air_date` + `status: Returning Series`
   → "Season N announced, no date yet". No LLM.
2. **New shows → confidence gate (OR logic, as specified).** Candidates from
   `discover/tv?first_air_date.gte/lte&with_original_language=en` (98 in the
   test window). Show if **`popularity ≥ tv.popularity_min` (TV scale,
   seeded at 15 — "very anticipated")** OR **confidence ≥
   `tv.confidence_min` (seeded at 0.75)**.
3. **Confidence = rules + LLM combination** (the "or perhaps something
   else/combination" question): a **rule component** (genre histogram
   overlap with the seen-shows profile, creator overlap, network overlap —
   cheap, deterministic, always computed) feeds a **`taste` LLM stage** that
   sees the taste profile + top candidates and returns
   `{id, confidence, reason}` per show in one batched call. `off |
   rules-only | llm` per `models.yaml` — rules-only mode is the degraded
   path, so the lane never goes dark. Reasons render as the row's rationale
   ("shares Severance's creator and genre stack").

Attribution: "This product uses the TMDB API but is not endorsed or
certified by TMDB." (shared footer with the movies feature).

## Costs and limits

- TMDB free, no daily cap (~40 req/s soft limit). Per run: 1 discover page
  or two + one details call per candidate that reaches LLM scoring (tens of
  requests), + cached seen-show lookups.
- `taste` LLM stage: one batched call per run over candidates that passed
  the cheap rules filter — small at ~$0.001 on Gemini free tier.

## Follow-ups

- [ ] Seed `tv.seen_shows` with the real list (user task); resolution helper
      for ambiguous titles (US/UK "The Office" class).
- [ ] `popularity_min: 15` and `confidence_min: 0.75` are seeded from this
      window's distribution — tune against the gold set.
- [ ] Taste profile digest format for the LLM call (genres histogram +
      creators + networks + how many seen-show titles to include).
- [ ] Mid-season continuation rows: skip (current default) or show "new
      episode tonight" for seen shows?
- [ ] TV output merges with movies in the UI "Coming up" block (user: "we
      might want them appearing together") — layout question for the density
      pass.
