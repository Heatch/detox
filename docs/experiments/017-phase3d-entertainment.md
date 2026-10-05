# 017 — Phase 3D: entertainment (movies, TV+taste, concerts, games, music)

Status: decided 2026-10-04 | Revisit: 2027-01-01

## Question

Four adapter families close the dashboard: TMDB movies + TV, Ticketmaster
concerts, Steam wishlist + ITAD prices, Spotify artist set + MusicBrainz
calendar. Do the documented shapes hold live, and where do they assemble?

## Method

Live probes per family (TMDB people/discover/details/tv, Ticketmaster
city pull, Steam chain, ITAD lookup, MusicBrainz resolve, Spotify
refresh), then full pipeline runs (20–22) + dashboard check.

## Result

- **TMDB as documented.** People search, `with_people` pipe-OR, tier-2
  discover (997 films/60 d), TV details with `seasons[]` tail, genres,
  networks, creators. One correction: `/movie/1` 404s in probes — test
  with real IDs only.
- **TV seasons work from the tail.** First live run: Sterling Point S2,
  Severance S3, Georgie & Mandy S3 (dated 2026-10-08), Stuart Fails S2 —
  all "announced, no date yet" except the dated one. `next_episode_to_air`
  null throughout, confirming exp 011.
- **Live taste fires.** 11 gated candidates → LLM reasons naming the
  user's actual watched shows ("matches their strong enthusiasm for
  WandaVision…"). Two hardening fixes from live failures: model ignores
  140-char caps → schema widened to 280, display truncates at a word
  boundary with ellipsis; taste prompt already says 25 words max.
- **Concerts match exp 003's own finds.** Olivia Rodrigo Oct 26–27, Doja
  Cat Nov 25, Scotiabank Arena — city pull + attraction matching works.
  Past events surface despite `sort=date,asc`, so dates filter
  client-side; tribute shows rejected by name rule.
- **Games: ITAD key works, universal-lowest confirmed.** 3 wishlist games
  all discounted (Deep Rock 70%, PvZ 40%, Satisfactory 30%). Steam-only
  fallback path coded, not yet triggered live.
- **Spotify refresh works from stored tokens.** Artist set 25 + 1 manual,
  shared between music and concerts via an in-process day-memo (concurrent
  collection would otherwise race the refresh-token rotation).
- **MusicBrainz throttled the fill.** ~150 requests across probes + runs
  tripped IP-side 403s (isolated singles still 200). Resolve path proven
  pre-throttle; release query proven in exp 004; code unit-tested. Pacing
  raised to 2 s, 403s retry once after 30 s, resolves cache forever — the
  lane self-fills on the next unblocked run with zero code changes.

## Decision

- `entertainment.tmdb`: tier-1 (watchlist, credits-checked reasons, cap 5)
  + tier-2 (budget/studio, cap 3) + all new seasons + top-3 taste shows.
  Releases table rows per kept item. New `concerts` lane id.
- `entertainment.concerts`: own lane, max 4 city pages, date-ordered.
- `entertainment.games`: sale rows only, deepest cut first, historical-low
  flag when the deal beats `historyLow.all`. New `wishlist` table.
  Vouchers out, unreleased/no-price omitted (deals-only lock).
- `entertainment.music`: artist set + MusicBrainz `[-30 d, +60 d]`,
  Official only, per-release-group dedupe, honest date precision, kind
  tags (deluxe incl. "encore", reissue, soundtrack, compilation, ep).
- Releases lane order: watchlist films, seasons, tier-2 films, taste
  shows, music. TMDB attribution in the footer (required).
- Digest unchanged (no entertainment line — weather/game/urgent carry it).

## Costs and limits

3D adds per run: TMDB ~40 first run then ~10 (24 h caches), Ticketmaster
≤4, Steam ~5, ITAD 2, Spotify 1–2, MusicBrainz ~50 first fill then ~25.
Morning run ≈ 150 requests total, all keyless except Newsflash/LLM/TMDB.

## Open / unverified

- **Music release rows** (code path verified, data pending unblock).
- Steam-only fallback, `show_reissues: false` branch, popularity-bypass
  taste picks (no ≥15-pop low-confidence candidate observed yet).
- Title-resolution ambiguity (Sterling Point etc. take first TMDB hit —
  exp 011's pinning advice applies if a mismatch surfaces).
- Short_term vs medium_term blend for the artist set (Tyla is medium-only
  #23 — same argument as the concert data point).
