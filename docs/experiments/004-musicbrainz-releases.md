# 004 — Release calendar: MusicBrainz vs Spotify vs Newsflash

Status: decided 2026-09-30 (MusicBrainz alone, no Newsflash for music) | Revisit: 2027-01-01

## Question

What powers the Coming up lane's music rows — and specifically, can
**MusicBrainz alone** do it (dropping the Spotify catalog scan and any
Newsflash dependency for releases)?

## Method

Ground truth first: verified actual new-music releases for the artist set
(top 25 short_term + 6 medium_term-only) from published release calendars
(Billboard, Pitchfork, Consequence, Official Charts, Wikipedia) — *not* from
the sources under test. An earlier round used unverified items and drew two
wrong conclusions (see Corrections below).

Then three probes on 2026-09-30:

1. **MusicBrainz, release-level** (the correct level — see Corrections):
   `GET /ws/2/release?query=arid:<mbid> AND date:[range]`, which returns
   every edition (deluxe, Atmos, regional) with its own date. Also
   release-group browsing and the global future-date range query.
2. **Spotify catalog**: per-artist `/artists/{id}/albums` (`album`/`single`
   separately, `market=CA`, `limit=10`). Incomplete — rate-limit incident.
3. **Newsflash**: per-artist event queries and the generic release-stream
   semantic query, against the same ground truth.

## Corrections to round one (important)

- **"MusicBrainz misses deluxe editions" — wrong.** My probe used
  release-group `first-release-date`, which stays at the original album's
  date for editions within the group. At **release level**, MusicBrainz has
  "The Life of a Showgirl: The Encore" with date 2026-09-25 (5+ variants).
  The gap was my method, not the database.
- **"Katy Perry's upcoming release" — ill-informed.** "The Vent Sessions"
  (Oct 2) is a vinyl/compilation single, not new music. Newsflash ignoring
  it was correct behavior; counting it against Newsflash was wrong. It is
  only "noise" for a new-music-only calendar — and arguably a legitimate row
  for an all-releases calendar (see Design note).
- **Travis Scott criticism of Newsflash — actually understated.** His two
  recent MusicBrainz items are real new-music singles ("GASS" Sept 3;
  "RHYNO" Sept 17, GTA VI soundtrack) — not vinyl noise. Newsflash saw
  **zero** of them. That is a genuine Newsflash miss.

## Result — scoreboard against verified ground truth

| Verified release | Date | MusicBrainz (release-level) | Newsflash |
|---|---|---|---|
| Carly Rae Jepsen — *Day and Night* (album) | Sep 18 | found | found (2 events) |
| Taylor Swift — *Showgirl: The Encore* (4 new songs) | Sep 25 | found (5+ variants) | found (announcement Sep 23–24 + release coverage) |
| Taylor Swift — *Patient Zero* (single) | Sep 25, Oct 13 versions | found (incl. acoustic + piano Oct 13) | partial (MV news only, no date) |
| Travis Scott — *GASS* (single) | Sep 3 | found | **missed** |
| Travis Scott — *RHYNO* (GTA VI soundtrack) | Sep 17 | found (tagged Soundtrack) | **missed** |
| The Beatles — *Rubber Soul (Super Deluxe)* | Oct 2 | found, future-dated | not tested |
| U2 — *Carnaval De Luz* | Nov 13 | **missed** (editor lag) | found (announcement Sep 23–24) |

**MusicBrainz: 6/7. Newsflash: 3/7.** Future dates work: Patient Zero
(Oct 13) and Rubber Soul Super Deluxe (Oct 2) are already dated entries.

**The one MusicBrainz miss is the interesting one:** U2's album (announced
Sep 23, dated Nov 13) is not yet in MusicBrainz — only bootlegs are. It is
editor-lag on a recently announced album, not a structural gap; Taylor
Swift's Oct 13 releases show the same database catching future items fine
for closely followed artists. Known limitation: less-followed artists can
lag days-to-weeks after announcement.

**MusicBrainz data-quality rules that fall out of the probe:**

- Dedupe mandatory: "Showgirl: The Encore" appears 5+ times (regions,
  formats, Dolby Atmos). Key: (release-group id + date), collapse to one row.
- Filter `status:Official` — bootlegs appear ("Opalite", "More Than Love").
- `date` precision varies (year/month/day) — render honestly.
- ~13% `503` rate under load even at 1.3 s spacing; retry with backoff,
  1.5–2 s spacing is safer. No key, no cost, ~31–62 requests per run.
- Artist resolution needs exact-name/alias matching with tribute-band
  rejection (round one matched "Kanye West Tribute Band"); note "Kanye West"
  may resolve via alias to "Ye".

**Spotify quirks (unchanged, scan still blocked until ~16:30 UTC Oct 1):**
`limit` max 10 on `/artists/{id}/albums` (not 50), combined
`include_groups` breaks pagination, dynamic 429 escalation to a ~24 h
penalty under scan patterns (`Retry-After: 84288` observed).

**Newsflash on releases (unchanged verdict):** great for big-artist
announcements and press color, blind to unheralded singles, no structured
dates, heavy non-English leakage in the music lane.

## Decision (MusicBrainz alone — signed off 2026-09-30)

**MusicBrainz alone powers the release calendar. No Newsflash for music.**
Spotify steps back to artist-list duty only.

1. **MusicBrainz = the calendar.** Release-level query per artist over
   [today−30d, today+60d], `status:Official`, deduped per release-group,
   date-precision-aware. Rows carry kind (album / single / deluxe / reissue
   / soundtrack) from the release-group's primary + secondary types.
2. **Spotify = top-25 artist list only** (2 requests/day). No catalog
   scanning — which also removes the rate-limit exposure entirely. Optional
   later: "listen on Spotify" links via one search lookup per displayed row.
3. **Newsflash: rejected for music.** (The "just announced, no date yet"
   case — U2's album — is the one thing lost; it is accepted as editor-lag
   risk, and Newsflash remains the news-lanes backbone where it belongs.)

Why not Spotify+Newsflash (round one's recommendation): the Spotify scan is
the most fragile piece we tested (rate-limit penalties, two API quirks) and
its coverage advantage over MusicBrainz is unproven — while MusicBrainz
alone scored 6/7 on verified truth with structured dates both directions.

**Design note:** show reissues and vinyl with a kind tag rather than hiding
them. The artist set skews catalog-heavy (Bowie, The Beatles, Britney) —
Rubber Soul Super Deluxe on Oct 2 is exactly what "Coming up" is for. A
new-music-only filter would have hidden the Encore and Rubber Soul both.

## Costs and limits

- MusicBrainz: free, no key, no auth. ~1 req/s etiquette (User-Agent
  required), 503 retry with backoff, 2 requests per artist per run.
- Spotify: 2 requests/day (top artists). Tokens in `data/spotify_tokens.json`.
- Newsflash: 1–2 queries per run if the overlay is enabled (from the
  existing free tier).
- No LLM involvement in any of this.

## Follow-ups

- [x] Fold into plan §9.4 — done 2026-09-30.
- [x] Further Spotify experimentation cancelled 2026-09-30: MusicBrainz
      works, so the deferred coverage scan is unnecessary. Spotify remains
      artist-set duty only (2 requests/day).
- [ ] Artist resolution helper: exact-name/alias match, tribute-band
      rejection, "Kanye West"→"Ye" alias case.
