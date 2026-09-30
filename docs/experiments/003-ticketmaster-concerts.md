# 003 — Toronto concerts via Ticketmaster Discovery

Status: decided 2026-09-30 | Revisit: 2027-01-01

## Question

Can we surface upcoming Toronto concerts for my top artists (the bonus part of
the Coming up lane), and which query method actually works?

## Candidates

- **Ticketmaster Discovery API** — free key, event search by city/date/attraction.
- Songkick API 3.0 — artist calendar endpoint, metro-area model. (Access terms
  reportedly tightened toward paid; not tested.)
- Bandsintown — best raw listing coverage but no usable public city/date API;
  scraping is off the table.

## Method

Live probing 2026-09-30 with the free key (`TICKETMASTER_KEY` in `.env`).
Two query strategies tested against the same 31-artist set (top 25 short_term
plus the 6 medium_term-only artists):

1. **Per-artist keyword search** — `keyword=<artist>` + `city=Toronto`,
   one request per artist.
2. **City-wide pull + attraction-name matching** — one paginated pull of all
   Toronto music events in the window, then match
   `_embedded.attractions[].name` against the artist list client-side
   (normalized: case-fold, strip diacritics/punctuation — needed for
   Beyoncé/Beyonce and JAY-Z-style spellings).

Window tested: 2026-09-30 to 2026-11-29 (60 days), `classificationName=music`.

## Result

**The pull works.** 579 Toronto music events over 60 days (3 pages of 200);
GTA-wide `latlong=43.6532,-79.3832&radius=50&unit=km` returns 624. The 45
non-Toronto events produced zero additional top-artist hits in this sample.

**Top-artist concerts found (4 events, all Toronto):**

| Date | Artist | Event | Venue |
|---|---|---|---|
| 2026-10-26 | Olivia Rodrigo | The Unraveled Tour | Scotiabank Arena |
| 2026-10-27 | Olivia Rodrigo | The Unraveled Tour | Scotiabank Arena |
| 2026-11-25 | Doja Cat | Tour Ma Vie World Tour | Scotiabank Arena |
| 2026-11-26 | Tyla | The A*POP World Tour | Coca-Cola Coliseum |

**Keyword search is a trap — method 2 wins decisively:**

- `keyword=Drake` → 31 "hits", **zero** actual Drake events. The term matches
  unrelated small-venue listings text.
- `keyword=Taylor Swift` → 1 hit, and it is *20 Years of Taylor Swift Dance
  Party* — a tribute night with an empty attractions list.
- All 4 real hits came from attraction-name matching in the city-wide pull.

**Artist-set observation:** Tyla is a `medium_term`-only artist. The
short_term-25 alone would have missed a real Toronto concert. For concerts,
the blended 31-artist set wins (this is the strongest data point so far in the
blend question left open in experiment 002).

## Decision

**Ticketmaster Discovery is the concert source.** Query shape:

```
GET /discovery/v2/events.json
  ?apikey=$TICKETMASTER_KEY
  &city=Toronto&countryCode=CA          (or latlong+radius for GTA-wide)
  &classificationName=music
  &startDateTime=<today>T00:00:00Z
  &endDateTime=<today+60d>T23:59:59Z
  &size=200&sort=date,asc&page=0..n
```

Match `_embedded.attractions[].name` against the blended artist list
normalized (NFKD, strip diacritics, fold case and punctuation). Rows carry
date, artist, event name, venue, city, and the Ticketmaster URL.

Scope default: `city=Toronto` ("in town"); the GTA-radius variant is a config
switch (`concerts.radius_km`) since it costs the same 3 requests and found
nothing extra in this sample but might for suburban venues.

## Costs and limits

- Free tier: 5,000 requests/day. A run costs 3–4 requests (city pull, 3 pages)
  — trivial headroom.
- Key + secret live in `.env` (`TICKETMASTER_KEY`, `TICKETMASTER_SECRET`);
  the Discovery API authenticates with `apikey=` query param alone.
- Note: `size=200` accepted; pagination via `page` + `page.totalPages`.
- No LLM involvement: structured matching only.

## Follow-ups

- [ ] Watchlist coverage: festivals and multi-act bills list all attractions,
      so matches should also check `event.name` when the attraction list is
      empty (tribute nights are the false-positive cost — acceptable).
- [ ] Cross-check against Songkick artist calendars if free access reappears
      (better for "artist plays a 200-person venue" cases).
- [ ] Decide ticket alert behavior: show in Coming up lane only, or also
      mention when an on-sale date is near (`dates.status`, `priceRanges`).
