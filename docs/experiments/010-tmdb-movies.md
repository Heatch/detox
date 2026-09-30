# 010 — Movies: TMDB with actor watchlist + bigness filter

Status: validated 2026-09-30 (TMDB live with key) | Revisit: 2027-01-01

## Question

Movies half of the release lane (TV is a separate feature now — different
volume, possibly different sources). Requirements from the brief:

1. Config list of actors/actresses — any upcoming movie with one of those
   people must appear (next 60 days if possible).
2. All other upcoming movies: English language only, and "sufficiently big
   only" — $20M budget as a threshold *benchmark*, explicitly not a hard
   requirement ("we don't absolutely need this datapoint").

## Candidates

- **TMDB** (`api.themoviedb.org/3`) — the plan's first candidate; key
  provided (`TMDB_API_KEY` in `.env`).
- OMDb — metadata only, no upcoming/discovery surface.
- The Numbers / Box Office Mojo — real budget data but scraping.
- TVmaze/Trakt — TV-oriented (TV experiment is separate).

## Method

Live probes 2026-09-30: the 60-day discover window under each filter
combination, actor name→ID resolution, `with_cast`/`with_people` OR-queries
with a **round-trip test** (pull an actor from a window film, query with
their ID, require the film back), `with_release_type`/`region` behavior,
and budget availability on details for a 12-film sample.

## Result

**Window volume** (2026-09-30 → 2026-11-29): 2,481 raw → **1,076 with
`with_original_language=en`**. So the filters are doing real work, and the
final "big" list should land in the dozens — matching the "not that many new
popular movies" expectation.

**Actor watchlist: works in exactly one request.** Names resolve via
`/search/person` (e.g. "Michael B. Jordan" → id 135651, known_for confirms
the right person); then `with_people=<id1|id2|…>` (pipe = OR) returns the
union across all listed people for the window. Round-trip verified: Liam
Neeson (id 3896, pulled from *The Mongoose*'s cast) → `with_cast=3896` →
returns *The Mongoose* (2026-10-29). My first test's "0 movies" was real
signal too — five sample A-listers genuinely have nothing releasing in the
window; expect empty watchlist rows on most days.

**The budget gap is real: 3 of 12 sample films carry a budget.**
Hunger Games: Sunrise on the Reaping $170M, Verity $40M, Clayface $40M —
and $0/unknown for The Mongoose, Street Fighter (Capcom + Legendary!),
Other Mommy (Blumhouse + Atomic Monster), and 6 others. Budget alone would
reject exactly the "sufficiently big" films the brief wants. What *is*
available on details: `production_companies` — and it separates the sample
cleanly: Street Fighter/Legendary and Other Mommy/Blumhouse pass;
The Mongoose (Code Entertainment + The Solution, an indie sales outfit)
fails despite pop 226.

**Proxy quality notes:**

- **`popularity` is not a bigness signal** — it spikes near release
  (The Mongoose: 226 vs Hunger Games: 15). Useful for ordering, not for
  thresholding.
- **`vote_count` is useless pre-release** — 0 for every unreleased film.
- **`with_release_type` is not a filter** — it is a date-selection modifier
  (which regional date wins when `region` is set). All three test queries
  returned identical counts (1,076). Do not use it as a "theatrical = big"
  shortcut; it filters nothing.

## Decision

**TMDB for movies, two tiers:**

1. **Tier 1 — actor watchlist (always shows).** `with_people=<pipe-OR of
   person IDs>` over the window, **no language/budget filter** (the brief:
   "we need to see it"). `with_people` over `with_cast` so a listed person
   credited as producer/director on a film still matches ("has one of those
   people"). Person IDs resolved once via `/search/person`, cached forever.
2. **Tier 2 — everyone else.** `with_original_language=en`, and
   "sufficiently big" by composite rule: **budget ≥ $20M when known, else
   production company in the configured major-studio list** (Blumhouse,
   Legendary, DC Studios, etc. — names in config, resolved to company IDs
   and cached, same pattern as people). Popularity orders the output but
   never gates it.

Config (`interests.yaml`): `movies.people`, `window_days: 60`,
`language: en`, `budget_min_m: 20`, `bigness_fallback: major_studios`,
`major_studios: [...]`. Rows carry: title, date, tier, and the reason
("with Zendaya" / "$40M budget" / "Warner Bros.").

Attribution requirement: "This product uses the TMDB API but is not
endorsed or certified by TMDB." — goes in the dashboard footer.

## Costs and limits

- TMDB is free (non-commercial, attribution required). Legacy rate limits
  disabled; soft cap ~40–50 req/s per IP, no daily maximum (TMDB admin
  confirmation on their forum). One run: 1 watchlist query + a few pages of
  tier-2 discovery + details fetches only for budget-ambiguous candidates —
  tens of requests.

## Follow-ups

- [ ] Bigness fallback tuning: is the studio list right, or should tier 2b
      fetch details for the top-N by popularity and let budget ≥ $20M catch
      well-funded non-studio films? (The $20M indie-with-no-major-studio is
      rare but real.)
- [ ] "60 days if possible" — soft window for tier 1? (e.g. extend watchlist
      hits to 75 days, or surface "just beyond the window" quietly.)
- [ ] Person/company name→ID resolution edge cases (duplicate names;
      "Michael B. Jordan" resolved correctly — verify a few more).
- [ ] TV half is a separate feature (source experiment pending) but will
      likely want the same people list — share the config block.
