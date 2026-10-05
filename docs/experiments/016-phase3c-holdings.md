# 016 — Phase 3C: Yahoo Holdings lane (news live, earnings throttled)

Status: decided 2026-10-04 (earnings live via quote-page fallback; crumb path kept as preferred when unthrottled) | Revisit: 2027-01-01

## Question

28 real tickers are in `config/holdings.md`. Can the Yahoo single-source
design (experiment 008) go live end to end: per-symbol RSS news +
quoteSummary earnings with the cookie+crumb handshake?

## Method

Live probes (RSS × 3 symbols; crumb handshake × 3 attempts over ~10 min),
then full pipeline runs (16, 17) + dashboard check. No new dependencies —
plain fetch throughout.

## Result

- **RSS: perfect.** 25/28 symbols kept (3 ETFs excluded at resolve time);
  8–20 items per symbol; per-symbol attribution exact. Promo filter v1 cuts
  0–50% depending on ticker (mega-caps carry the most opinion content).
- **Crumb endpoint throttled: 429 on all attempts.** `fc.yahoo.com` 404s
  but still sets the A3 cookie; a full quote page (200) sets no capturable
  cookies via undici; `getcrumb` 429s regardless of jar, cooldown (65 s),
  or source. quoteSummary without a crumb 401s ("Invalid Crumb").
  Experiment 008 succeeded from this host on 2026-09-30, so this reads as
  transient IP-side throttling, not a dead flow.
- **No `yahoo-finance2`.** Same endpoints, same throttle, plus dependency
  weight. The ~15-line manual handshake is equivalent; the SDK's breakage-
  tracking argument is noted but doesn't buy anything while throttled.
- **News selection needs a per-ticker cap.** First live lane was 4/5 NVDA
  (recency-only scoring + high-volume feed). Cap: 3 candidates per ticker
  pre-select, capped-out items keep audit rows ("ticker cap: max 3 per
  ticker"). Second run diversified to COST/NVDA/SOBO.
- **Promo filter v1 additions from live picks:** thestreet.com,
  "what X says about", Jim Cramer shapes. Residual opinion-bait
  ("Keeps Delivering… Price Tag Assuming?", market-wrap futures pieces)
  stays — judging importance needs gold news rows (Phase 4), not more
  heuristics.
- **Symbol resolution verified live in logs:** NEO:NVON→NVO returned news,
  TSX:HMM.A→HMM-A.TO returned 4 items, bare FN/MSGS/SN all resolved.

## Decision

- `holdings.yahoo` adapter: resolve (ETFs excluded) → per-symbol RSS with
  promo cuts → quoteSummary earnings. One adapter id, `payload.kind`
  separates news/earnings/earnings-status.
- **Earnings degrade to news-only with a lane note when Yahoo refuses**
  (crumb cached ~12 h in `data/cache`, refreshed once on mid-run 401,
  retried next run). No fake earnings rows, ever.
- **2026-10-04 addendum — quote pages replace the crumb.** The crumb
  endpoint 429'd across all attempts, but quote-page HTML (200, unthrottled)
  embeds the identical store: `earningsDate` + `isEarningsDateEstimate`,
  `financialCurrency`, `earningsChart.quarterly` (actual/estimate as raw or
  string, `surprisePct` string, `reportedDate`/`periodEndDate` epochs —
  quarterly `date` is a label like "3Q2025", never parsed for recency).
  Strategy per run: crumb+quoteSummary when available (cheap), quote pages
  otherwise (~1 MB × symbols). First live run: 22/25 symbols, 5 upcoming
  dates + 1 thin-data row, CDRs showing underlying names. `title` tag is
  the company-name source with holdings.md as fallback. No
  `yahoo-finance2` — same throttled endpoint, zero new dependencies.
- Lane shape: earnings rows (upcoming ≤30 d with estimate flags; recent
  ≤7 d with EPS surprise; thin-data names render "no recent results") +
  3–5 ticker-tagged news items. Newsflash stays out (exp 008).
- Digest does NOT mention earnings (scope lock: news + earnings display).

## Costs and limits

3C adds ~50 keyless requests per run (25 RSS + 25 quoteSummary at full
success). Morning run ≈ 70 requests total. No keys, no dollars.

## Open / unverified

- Promo v1, per-ticker cap of 3, and the 30-day horizon are judgment calls
  awaiting gold-set measurement.
- CDR display uses the quote-page title (underlying company) with the
  user's ticker as identifier, per exp 008.
- Related-ticker bleed in page extraction: `earningsDate` takes the first
  occurrence and `quarterly` is anchored on `earningsChart`, but a page
  redesign could break either silently — a sudden drop in earnings rows
  across symbols is the canary.
