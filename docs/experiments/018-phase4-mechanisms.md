# 018 — Phase 4: iteration mechanisms (weather scoring, blend, feedback)

Status: decided 2026-10-04 | Revisit: 2027-01-01

## Question

Phase 4's exit is per-feature iteration with data behind it. Which
mechanisms ship now, and which tuning stays for the feature-by-feature
pass?

## Result

- **`pnpm weather:score` answers the §9.2 question on first data.**
  Stored day-max forecasts (openmeteo/metno recomputed from saved
  payloads via the pipeline's own extractors; consensus from saved
  medians) vs Open-Meteo archive observed maxima. First run (2 days,
  n=25 each): consensus wins everywhere — Toronto MAE 0.7° (vs 0.8/0.9),
  Vaughan 0.9° (vs 0.9/1.2), Waterloo 0.4° (vs 0.6/1.4). MET Norway runs
  cold everywhere (bias −0.9 to −1.4°). EC skipped (weekday-named periods
  can't align without build-time context); consensus still covers it via
  the median. Correction to the plan: "historical-forecast API" means the
  keyless archive API (ERA5 observed), which is what's needed. ERA5 lags
  several days — the tool says so instead of scoring nothing.
- **Artist blend decided (closes 002's open question).** Union
  short+medium by Spotify id + manual (`blend_medium_term: true`, one
  extra call per run). Data as above.
- **Feedback capture is a mechanism, not a feature.** `POST
  /api/feedback` (+1/−1, validated) into the existing `feedback` table;
  digest-level useful/not buttons reusing `.btn`. Verified round-trip
  live, test row removed. Per-item thumbs and any use of the judgments
  stay for the feature pass.

## Decision

Ship the three mechanisms; defer all tuning (tier weights, score floors,
per-lane negatives, prompt iteration, digest gold rows, column layout,
game-day promotion) to the feature-by-feature pass, each measured with
these tools. No LLM involvement in any of it.

## Costs and limits

Weather-score: 3 keyless archive calls, read-only on the DB. Feedback:
one row per click. Blend: +1 Spotify call and ~6 more MusicBrainz
resolves per run (inside exp 004's 31–62 estimate).
