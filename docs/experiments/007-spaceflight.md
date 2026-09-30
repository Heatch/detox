# 007 — Spaceflight: Spaceflight News API + Launch Library 2

Status: validated 2026-09-30 (both keyless and parseable) | Revisit: 2027-01-01

## Question

Newsflash is out for spaceflight (decision: its spaceflight coverage runs
through the general news query and isn't the right shape). Two needs:
1. **Spaceflight news** from the Spaceflight News API.
2. **Upcoming launches** as their own dashboard section — not grouped with
   news — showing only upcoming launches.

Verify both are accessible and parseable.

## Candidates

- **Spaceflight News API** (`api.spaceflightnewsapi.net/v4/`) — the named
  source for spaceflight news.
- **Launch Library 2** (`ll.thespacedevs.com/2.2.0/`) — the standard
  structured launch source (already a candidate in plan §9.6).

## Method

Live probe 2026-09-30: endpoint discovery, latest-article parsing, endpoint
coverage (`/articles`, `/blogs`, `/reports`, `/info`), filtering
(`news_site`, `search`), and the full upcoming-launch listing with field
inspection.

## Result

**Spaceflight News API — works.** 36,286 articles + 2,127 blogs + 1,415
reports indexed; 42 tracked outlets including NASA, SpaceNews, Spaceflight
Now, and Ars Technica. Keyless, no auth.

```
GET https://api.spaceflightnewsapi.net/v4/articles/?limit=25&ordering=-published_at
     &news_site=Spaceflight Now    (optional outlet filter)
     &search=Starship              (optional text filter)
```

- **Base URL is `api.spaceflightnewsapi.net/v4/`** — the docs site
  `spaceflightnewsapi.net/api/v4/...` 404s; get this wrong and everything
  silently fails.
- Article fields: `id`, `title`, `url`, `image_url`, `news_site`,
  `published_at`, `updated_at`, `summary` (clean dek-style text), `authors`,
  `featured`, `launches[]`, `events[]` (cross-links to Launch Library IDs).
- The `summary` field is publication-quality one-liner material — same
  "no LLM needed" property as Newsflash's canonical summaries.

**Launch Library 2 — works.** 452 upcoming launches on the books. `GET
/launch/upcoming/?limit=N&ordering=net` returns, per launch: `name`, `net`
(launch time), `window_start`/`window_end`, `net_precision`, `status`
(`Go`, `TBD` etc. with description), `pad.name` + location, 
`launch_service_provider`, `mission` (name + description), `webcast_live`,
`vidURLs`, `image`, `probability`, `weather_concerns`. Sample reads like a
built-in section: "Falcon 9 Block 5 | Crew-13, Oct 1 15:10, SLC-40, Go".

- Guest access is rate-limited (a free The Space Devs token raises the
  ceiling) — one request per run for the section, so fine either way;
  register if the guest limit ever bites.
- Only *upcoming* launches are wanted (explicit) — the `/upcoming/` endpoint
  is exactly that; no past-launch handling needed.

## Decision

**Spaceflight gets two dedicated sources and two shapes:**

1. **Spaceflight news** → Spaceflight News API (replaces Newsflash for this
   lane). Queries: `news_site` filters for the specialist outlets +
   `search` terms from `interests.yaml`; `ordering=-published_at`; keep the
   `summary` field as the one-liner (rules-only, like the Newsflash lanes).
2. **Upcoming launches** → Launch Library 2, own section of the dashboard
   (not mixed into news): next N launches with date/time, vehicle + mission,
   pad + location, status, webcast flag. Sorted by `net`. Only upcoming.

The `launches[]` cross-link on news articles ties the two together (an
article about Crew-13 can carry the launch ID).

## Costs and limits

- Both keyless. Spaceflight News API: no published limit concerns at our
  volume (2–3 requests per run). Launch Library 2: guest throttled, one
  request per run; free token available if needed.
- No LLM involvement.

## Follow-ups

- [ ] Which outlets/queries from `interests.yaml` shape the news side
      (specialist-outlet filter vs free-text)? Tune against the gold set.
- [ ] Launch section scope: next 5? next 30 days? Include only
      `status.abbrev == Go` or show TBD dates too (probably show all,
      status as a column).
- [ ] Should a launch within 48 h get a promoted position in the dashboard
      (like the Raptors section on game days)?
