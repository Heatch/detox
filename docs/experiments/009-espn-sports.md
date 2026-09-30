# 009 — Sports: ESPN for schedule + injuries (extensible across Toronto teams)

Status: validated 2026-09-30 (all four Toronto teams on one endpoint shape) | Revisit: 2027-01-01

## Question

Raptors lane needs upcoming games + injury report — **no news** (Reddit and
Newsflash cover that). The design must make adding the Jays, Leafs, and Tempo
a config change. Is the ESPN site API right, and what are the quirks?

## Candidates

- **ESPN's site API** (`site.api.espn.com`, undocumented but long-stable JSON)
  — the named first choice.
- NBA.com stats endpoints (`nba_api`) — official but NBA-only, fragile headers.
- NBA official injury report (PDF) — authoritative but PDF parsing, NBA-only.
- Rotowire etc. — scraping, derivative.

## Method

Live probes 2026-09-30: schedule + injuries endpoints for all four Toronto
teams (Raptors/Blue Jays/Maple Leafs/Tempo), field-shape inspection, injury
group inspection per team, season-boundary behavior.

## Result

**One endpoint shape covers every league** (the extensibility requirement
falls out for free):

```
GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{abbr}/schedule
GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries
```

| Team | sport/league | abbr | schedule now | injuries now |
|---|---|---|---|---|
| Toronto Raptors | basketball/nba | tor | 5 (preseason) | 3 |
| Toronto Blue Jays | baseball/mlb | tor | 0 (season over) | 13 |
| Maple Leafs | hockey/nhl | tor | 84 (full season) | 5 |
| Toronto Tempo | basketball/wnba | tor | 46 | 7 |

**The ESPN WAF quirk (critical).** Requests are rejected `403 Access Denied`
unless the User-Agent is present **and is a plain library UA**. Verified
matrix: `curl/8.4.0` → 200, `Python-urllib/3.11` → 200, no UA → 403,
`DetoxDashboard/0.1` → 403, browser Chrome UA → 403. This is inverted from
every other API we use: **do not send a custom or browser UA to ESPN**. The
adapter pins `User-Agent: curl/8.4.0` (or passes urllib's default).

**Schedule payload** per event: `date` (UTC ISO), `name` (display-ready:
"Miami Heat at Toronto Raptors"), `competitors[]` (homeAway, team id/name/
abbreviation), `status.type` (`STATUS_SCHEDULED` / `STATUS_FINAL` +
human `detail` like "Sat, October 3rd at 7:00 PM EDT"), `venue` (fullName +
city — first preseason game is at Videotron Centre, Quebec City;
`neutralSite` flag exists), `broadcasts[]`, `seasonType` (`pre`/`regular`).
Quirks: the endpoint returns the current season's *remaining* games (Leafs
84, Jays 0 in the offseason — lane must render empty gracefully), and
`seasonType=pre` means preseason rows should be labeled or filterable.

**Injuries payload** — league-wide, flat groups (`{id, displayName,
injuries[]}`, no nested team object): find the Toronto group by
`displayName`. Per entry: `athlete.displayName`, `status`, `date` (last
update), `shortComment`/`longComment` (with news-source attribution baked
in), `details` with `type`, `location`, `side`, `detail`, `returnDate`, and
`fantasyStatus.abbreviation` for compact display. Quirks:

- **Status vocabulary is league-specific**: NBA `Day-To-Day`/`Out` (fancy
  `GTD`), MLB `15-Day-IL`/`60-Day-IL`, NHL `Injured Reserve` (IR-LT/IR-NR),
  WNBA `Out`/`OFS`. Display must not assume one vocabulary.
- **Not every entry is an injury**: `details.type` can be "Coach's Decision"
  or "Personal" (Tempo had 2 of 7). Decide per league whether to show or
  filter.
- **`shortComment` is sometimes junk** ("ir-nr", "ir") — fall back to
  composing from `details` (type + side + returnDate) when the comment is
  not prose.
- `returnDate` present on most entries (e.g. Domi IR-LT, return 2026-11-21).

## Decision

**ESPN site API, both endpoints. No news from it.** The sports section is a
list of configured teams, each with a block showing next N games + its
injury table. Adding the Jays/Leafs/Tempo is config-only (proven live —
same shape, they already return data).

```yaml
# config/interests.yaml (team registry — the "add a team" surface)
sports:
  teams:
    - { id: raptors, name: Toronto Raptors, sport: basketball, league: nba, abbr: tor, enabled: true }
    - { id: bluejays, name: Toronto Blue Jays, sport: baseball, league: mlb, abbr: tor, enabled: false }
    - { id: leafs, name: Maple Leafs, sport: hockey, league: nhl, abbr: tor, enabled: false }
    - { id: tempo, name: Toronto Tempo, sport: basketball, league: wnba, abbr: tor, enabled: false }
  upcoming_games: 5
```

Adapter rules pinned by this experiment: plain-library UA only (the WAF
quirk); one `injuries` fetch per enabled league (covers every team in it);
filter injury groups by team `displayName`; render empty schedules
gracefully; label preseason rows; compose injury text from `details` when
`shortComment` is junk; carry `returnDate` when present.

## Costs and limits

- No key, no auth. Per run: 1 schedule request per enabled team + 1 injuries
  request per enabled league (4 requests today with all four teams on).
- Endpoints are undocumented; breakage risk is the ESPN redesign class —
  the adapter seam keeps `nba_api` and the official PDF report warm as
  fallbacks.

## Follow-ups

- [ ] Game-day promotion: should the Raptors block rise on game days (plan
      §9.9 open question) — cheap now that `status.detail` carries the time.
- [ ] Injury semantics per league: filter "Coach's Decision"/"Personal" or
      show them (they matter for fantasy-ish awareness but clutter a
      morning view)?
- [ ] `broadcasts[]` was empty in preseason — verify it fills for regular
      season (TSN/Sportsnet info would be useful on the game row).
- [ ] Tempo's `returnDate` values are all `2027-05-01` (season-over
      placeholder) — don't trust returnDate when the league pads it.
