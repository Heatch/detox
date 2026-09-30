# 008 — Holdings: Yahoo Finance for news + earnings (single source)

Status: decided 2026-09-30 (fully Yahoo — news and earnings) | Revisit: 2027-01-01

## Question

The Holdings lane needs, per the real portfolio in `config/holdings.md` (28
lines, auto-generated): important company news, upcoming earnings dates, and
recent earnings results. Can one source handle the news side (Newsflash
tradfi was the first candidate), and does Yahoo Finance have everything
needed for earnings? Watch for instrument technicalities (CDRs, class
shares, ETFs, mixed listing/reporting currencies).

## Candidates

- **Newsflash `category=tradfi`** (already in-house) and per-issuer Newsflash
  queries.
- **Yahoo Finance** — per-symbol news RSS + `quoteSummary` earnings
  (the plan's named candidate, via `yahoo-finance2`).
- Plan §9.7's other candidates (Finnhub, Alpha Vantage, SEC EDGAR, wire
  RSS, etc.) — not probed; Yahoo covered the need in-house.

## Method

Live probes 2026-09-30 against the real 25 investable symbols (28 lines
minus 3 ETFs):

1. Newsflash: `category=tradfi` over 28 days, plus 24 per-issuer queries
   (all categories vs tradfi-only), then targeted single-word retries for
   zero-hit names.
2. Yahoo symbol resolution (`v8/finance/chart/{sym}`) for every mapping
   hypothesis: `.TO` suffix, class-share variants, CDR literal vs underlying.
3. Yahoo earnings (`quoteSummary?modules=calendarEvents,earnings`) for all 25
   mapped symbols via the cookie+crumb flow.
4. Yahoo per-symbol news RSS for Newsflash-zero names; batched-RSS variant.

## Result

**Instrument taxonomy (28 lines in holdings.md):** 15 TSX stocks, 7 NEO CDRs
(CAD-hedged), 3 bare US tickers (FN, MSGS, SN), 3 ETFs (CBIL, XEN, NLR —
excluded from news/earnings per instruction).

**Symbol-mapping traps (all confirmed live):**

- **`NEO:NVON` → `NVO`** (Novo Nordisk ADR). The literal `NVON` 404s —
  CDR→underlying needs an explicit mapping table, not prefix stripping.
  Other CDRs happen to keep their ticker (BLK, COST, GOOG, MCD, NVDA, WMT).
- **`TSX:HMM.A` → `HMM-A.TO`** (dash convention); `HMM.A.TO` 404s.
- TSX stocks → `<ticker>.TO`; bare US tickers resolve as-is. All 25 resolve.
- **Reporting currency ≠ listing currency**: ATD reports USD on TSX, NVO
  reports DKK, most TSX names CAD. Label currency per item.
- **Thin-data micro-caps**: HMM-A.TO's Yahoo earnings history is stale (last
  row 2010) though it carries a forward date; needs a graceful "thin data"
  presentation.

**News verdict:**

- Newsflash `category=tradfi`: **unusable for this purpose** — 6 events in
  28 days, all macro/geopolitical (Fed, Suncorp, City Holding), zero issuer
  tie-ins. The tradfi corpus is finance *news outlets*, not issuer coverage.
- Newsflash per-issuer queries: strong on large caps (Dollarama incl. an
  earnings-call transcript, Couche-Tard Q1, Novo/Lilly, Manulife) but
  **systematically zero on small/mid-cap TSX names** (Apotex, Cipher,
  Finning, Power Corp, Hammond, MSGS). False positives on generic-word
  names (`Hammond` → an Indiana chemicals story; `Madison Square Garden`
  → LeBron news; `Power Corporation` → an unrelated PPC). Query phrasing
  is fragile (`"Alphabet Google"` matches nothing; `Google`/`Alphabet`
  separately work).
- Yahoo per-symbol RSS: **complete coverage of all 25**, exactly the
  "important company news" shape — press releases flow through it (Apotex's
  $1.25B senior notes offering, Power Corp dividend declaration, Finning
  earnings-call highlights, Cipher litigation win). Per-symbol attribution,
  no matching ambiguity. Caveats: no cross-outlet dedupe (the symbol tag
  serves instead) and promo/opinion pieces appear (Seeking Alpha-style
  content) — rule filtering needed.
- Batched RSS (all symbols in one call) works but is lossy: items aren't
  attributed to symbols and general market news crowds in. Per-symbol is
  the right shape.

**Earnings verdict: Yahoo has everything.** `quoteSummary` needs the
cookie+crumb handshake (what `yahoo-finance2` automates). All 25 symbols
returned: next earnings date with `isEarningsDateEstimate` flag (11 of 25
currently estimated), last report date, EPS actual vs estimate, surprise
percentage. Last round surprises ranged MSGS +84% and Vox Royalty +52% to
Cipher −20%. Exactly the "results if earnings were recent" feature.

## Decision (fully Yahoo — news and earnings)

**Yahoo Finance is the single source for the Holdings lane.** One adapter
family, two endpoints:

1. **News** → per-symbol RSS
   (`feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}`). 25 keyless calls
   per run. Filter promo/opinion pieces with rules (source-domain blocklist
   + title heuristics); the selection stage may judge the remainder later.
2. **Earnings** → `quoteSummary?modules=calendarEvents,earnings` via
   `yahoo-finance2` (handles the crumb automatically). Upcoming dates
   (30-day window per plan §9.7) + recent results with surprise.

**Symbol resolution rules (in `sources.yaml`):**

- ETFs (CBIL, XEN, NLR) excluded at parse time — no news/earnings fetched.
- NEO CDRs map through an explicit `cdr_map` (`NVON: NVO`, etc.); the row
  shows the underlying company but keeps the CDR ticker as the user's
  identifier.
- Class shares: dot → dash + `.TO` (`HMM.A` → `HMM-A.TO`).
- TSX → `.TO` suffix; bare tickers as-is (resolved US-first per
  holdings.md's own rule).
- Currency labeled per item from `financialCurrency` (CAD/USD/DKK).

Rejected: Newsflash for this lane (tradfi unusable, issuer queries
incomplete and false-positive-prone). Not probed: Finnhub/Alpha Vantage/
EDGAR/wire RSS — revisit only if Yahoo degrades.

## Costs and limits

- All keyless except the crumb handshake (cookie + `/v1/test/getcrumb` —
  no account, no key; `yahoo-finance2` handles it).
- Per run: 25 RSS + 25 quoteSummary calls — trivial. Earnings data is
  cacheable (changes weekly); news is the only per-run fetch that matters.
- Yahoo's unofficial endpoints have no SLA; `yahoo-finance2` tracks
  breakage upstream. The adapter seam keeps Finnhub/EDGAR warm as fallbacks.

## Follow-ups

- [ ] Promo/opinion filter rules for the RSS feed (domain blocklist +
      title heuristics) — currently a judgment call, tune against gold set.
- [ ] Thin-data handling (HMM.A) — render "no recent results" gracefully
      rather than a 2010 row.
- [ ] Confirm the 30-day earnings horizon reads well in the lane, or tighten.
- [ ] CDR rows: decide display name (underlying company vs "Costco CDR")
      in the UI density pass.
