# 015 — Phase 3B: ESPN sports, spaceflight news, launches

Status: decided 2026-10-04 | Revisit: 2027-01-01

## Question

Three keyless families go live: ESPN schedule+injuries (Raptors first),
Spaceflight News API articles, Launch Library 2 upcoming launches. Do the
documented shapes hold, and how do they assemble?

## Method

Live probes with the repo's own network (no keys needed), then a full
pipeline run (run 15) + dashboard check.

## Result

- **ESPN schedule shape differs from exp 009's description.** Game data
  lives under `competitions[0]`, not top-level: status at
  `competitions[0].status.type.{name,detail}`, `seasonType` is an object
  (`{abbreviation: "pre"}`), venue/competitors/broadcasts under
  `competitions[0]`. Adapter reads the probed shape. `name` is
  display-ready ("Miami Heat at Toronto Raptors") — no competitor parsing
  needed. `STATUS_FINAL` rows (already played) are dropped; only
  `STATUS_SCHEDULED` within `upcoming_games: 5` are kept. Broadcasts are
  empty in preseason, as exp 009 predicted.
- **ESPN injuries match exp 009 exactly.** Raptors group found by
  `displayName` (7 entries). Junk `shortComment` ("ir-nr" class) composes
  from `details` (type + side). Non-injury `details.type` values
  ("Coach's Decision", "Personal") stay visible with the type folded into
  the status — availability is availability. `returnDate` more than a year
  out is dropped as league padding (Tempo's 2027-05-01 class).
- **WAF quirk respected.** All ESPN traffic goes through the shared
  `fetchJson` with `User-Agent: curl/8.4.0` (pinned in `userAgentFor`,
  covered by test). No 403s observed.
- **Spaceflight News API as documented.** `news_site` filtering done
  client-side (25 fetched → 14 kept); all five selected items from
  specialist outlets (NASA, Spaceflight Now). `summary` is the one-liner;
  specialists get tier 1. Selection flows through the standard news path
  (recency + spaceflight topics + 7-day cap).
- **Launch Library 2 as documented.** 470 upcoming on the books; 5 kept,
  net-ordered, Toronto-local times, Go statuses. Guest access held for one
  request per run — no token needed yet.
- **Digest game line works by absence.** Next Raptors game is Oct 10
  (>36 h), so no game mention — correct. The line fires only when a game
  is within 36 h.

## Decision

- `sports.espn` adapter: enabled teams only (Raptors today; Jays/Leafs/
  Tempo are config flips). One injuries fetch per league. DB: one `games`
  row per team, one `injuries` row per entry. New `launches` table
  (run_id, launch_id, net, payload).
- Own dashboard sections for Sports (teams → games + injuries) and
  Launches (net-ordered rows); Spaceflight joins the news columns.
- `reddit-torontoraptors` added to `LaneIdSchema` (was a cast).
- 12 of 15 lanes real. Remaining: holdings (3C, tickers ready), movies /
  TV / concerts / games / music (3D).

## Costs and limits

3B adds ~3 requests per run (ESPN schedule + injuries, SFN articles,
LL2). Morning run ≈ 23 requests total, all keyless except Newsflash/LLM.
