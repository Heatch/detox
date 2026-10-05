# 002 — Upcoming releases from my top 25 artists (and Toronto concerts)

Status: decided 2026-10-04 (OAuth connected, artist blend implemented, MusicBrainz calendar live) | Revisit: 2027-01-01

## Question

How do we power the "Coming up" lane with upcoming releases from the artists I
actually care about — my top 25 current artists at any point — and, as a bonus,
upcoming Toronto concerts for those same artists?

## Decided parts

**Superseded in part by experiment 004 (2026-09-30):** the release *catalog*
flow below (per-artist Spotify album listings) is **retired** — MusicBrainz
release-level queries are the calendar now. What stands from this record: the
artist set, the OAuth setup, and the quirks list. Kept below for the record.

- **Artist set** = Spotify "top artists" (`user-top-read` scope),
  `time_range=short_term` (approximately the last 4 weeks), `limit=25`,
  re-fetched at each pipeline run so the set tracks current listening rather
  than a static config list. `config/interests.yaml` `music.artists` remains as
  a manual supplement for artists Spotify's affinity ranking misses.
- **Releases** = ~~per-artist album listing (`album` + `single` groups)~~
  **retired — see experiment 004** (MusicBrainz release-level queries are the
  calendar now). Original plan: filtered to future dates within the 60-day
  window the lane uses.
- **OAuth** = Authorization Code with PKCE, no client secret required. Tokens
  stored in `data/spotify_tokens.json` (gitignored), access token refreshed
  via the stored refresh token. Bootstrap and verification tooling lives in
  `scripts/spotify_auth.py` (setup tooling, not pipeline code).

## Setting up Spotify OAuth — what's done vs. what you do

Done on my end:

- `scripts/spotify_auth.py` — complete PKCE flow: starts a loopback listener,
  opens the browser to Spotify's authorize page, catches the redirect,
  exchanges the code, saves tokens, refreshes expired tokens on later runs,
  and prints your top 25 (short_term and medium_term) plus the overlap between
  them as a first data point for the blend experiment below.
- Redirect URI chosen to satisfy Spotify's dashboard validator:
  `http://127.0.0.1:43210/callback` — explicit loopback IP literal **with** an
  explicit port and a hyphen-free path. (Earlier drafts used the port-less
  dynamic form the docs allow; the dashboard validator rejects it — see
  Troubleshooting below.)

What only you can do (gaps to fill):

1. **Create the app.** Go to <https://developer.spotify.com/dashboard> →
   **Create app**. Suggested: name `Detox`, description anything. In the app
   settings:
   - **Redirect URIs:** add exactly `http://127.0.0.1:43210/callback`
     (with the port, no trailing slash, must match literally).
   - **Which API/SDK are you planning to use?** Web API.
   - Save. (Client secret is not needed for PKCE, but copying it is harmless;
     the script uses it automatically if `SPOTIFY_CLIENT_SECRET` is set.)
2. **Allowlist yourself.** New Spotify apps run in Development Mode: under
   **User Management**, add the email of the Spotify account that will log in.
   Without this, login fails with "user not registered".
3. **Copy the Client ID** into `.env` at the repo root:
   `SPOTIFY_CLIENT_ID=paste-id-here`.
4. **Run it.** `python scripts/spotify_auth.py`. Your browser opens Spotify's
   consent page → approve → the terminal prints your top 25 artists. Tokens
   land in `data/spotify_tokens.json`. Re-runs are silent until the access
   token expires (~1 hour), then refresh automatically.

**Troubleshooting.**

- **"This redirect URI is not secure" in the dashboard** — Spotify tightened
  redirect URI validation (enforced for new apps since April 2025, all apps
  since November 2025). What trips the validator:
  - `localhost` is banned outright; use the literal `127.0.0.1`.
  - Plain HTTP is only allowed for loopback IP literals.
  - The validator is stricter than the docs in practice: the port-less dynamic
    form (`http://127.0.0.1/callback`) and paths containing hyphens have both
    been reported as rejected with this exact error. Use an explicit port and
    a plain path: `http://127.0.0.1:43210/callback`.
- **"INVALID_CLIENT: Insecure redirect URI" at login** — the URI sent at
  authorize time doesn't byte-match what's registered (the script always sends
  `http://127.0.0.1:43210/callback`; if you changed `SPOTIFY_REDIRECT_PORT`,
  the registered URI must change with it).
- **"user not registered"** — step 2 is missing (Development Mode allowlist).
- **Port 43210 already in use** — the script says so and stops; either free the
  port or set `SPOTIFY_REDIRECT_PORT` in `.env` and register that URI instead.
- **SSL `CERTIFICATE_VERIFY_FAILED` on Windows Store Python** (hit
  2026-10-04) — it ships without CA certificates, so the token exchange
  fails even after a successful browser login. Fix: `pip install certifi`;
  `scripts/spotify_auth.py` now prefers certifi's bundle via `SSL_CERT_FILE`
  when importable (verified: handshake to accounts.spotify.com returns 200).

## Flow design (what the pipeline will do)

1. **Artists.** `GET /v1/me/top/artists?time_range=short_term&limit=25` —
   one request per run. Store artist id + name + genres.
2. **Releases.** For each artist: `GET /v1/artists/{id}/albums?market=CA`,
   one call per `include_groups` value (`album` and `single` separately — see
   quirks), `limit=50`. Filter `release_date >= today` and within 60 days.
   Dedupe on album id (a feature/single can surface under two artists).
3. **Display.** Sort by date; use `release_date_precision` to render the date
   honestly ("17 October" vs "October 2026"); attach the artist name and the
   kind (album, single).
4. **Concerts (bonus).** For each of the 25 artists, query the concert
   candidate for Toronto events in the same 60-day window; rows show date,
   artist, venue.

Roughly 2 + 25×2 = 52 requests per run for releases, plus ~25 for concerts.
Comfortably within all the free tiers involved.

## Observed quirks (from research, to re-verify with real data)

- **Future releases do appear in the artist-albums catalog**, but coverage is
  patchy: announced albums can be absent until close to release, and some
  carry placeholder dates (e.g. `31 December` of a year). `release_date_precision`
  of `year` or `month` is the tell. Anything with non-day precision should
  render loosely and can be cross-checked against a second source later.
- **Combined `include_groups` breaks pagination.** Community-verified: asking
  for `album,single` in one call returns groups concatenated and paginates
  wrong. Query each group separately.
- **`limit` maxes out at 10, not the documented 50.** Verified live
  (2026-09-30): `limit=11` and above return `400 Invalid limit` on
  `/artists/{id}/albums`; `limit=10` works, `offset` pagination works, and
  `total=263` for Taylor Swift means real pagination is required to see the
  full catalog. Batch the pipeline at `limit=10` per group per artist.
- **Dynamic rate limiting hits hard.** Rapid sequential probing trips `429`
  with `Retry-After` headers (observed up to ~5 min of backoff during a
  31-artist scan). The pipeline needs the retry-with-`Retry-After` loop plus
  spacing; one run's full scan is ~62 requests, which is fine when paced.
- **No sort parameter.** Results come grouped by type, then date. Sort
  client-side.
- **`market=CA`** keeps the list to what's actually available here and trims
  odd regional editions.
- **Affinity windows:** `short_term` ≈ 4 weeks, `medium_term` ≈ 6 months.
  Whether the lane should use short_term alone or blend both is the first
  experiment — the bootstrap script prints both lists and their overlap to
  make that call with data.

## Concert candidates (bonus — decided in experiment 003)

Concert discovery moved to its own record: **003-ticketmaster-concerts.md**.
Ticketmaster Discovery is the source, using the city-wide pull +
attraction-name matching method (per-artist keyword search is a proven trap —
`keyword=Drake` returns 31 events, none of them Drake). First real finds:
Olivia Rodrigo (Oct 26–27), Doja Cat (Nov 25), Tyla (Nov 26).

## Costs and limits

- Spotify Web API: free with a developer account; rate limits are dynamic
  (long-term average ~180 req/min) — our ~52 requests per run is trivial.
- Access tokens live ~1 hour; the stored refresh token keeps the pipeline
  unattended indefinitely (revoke anytime from your Spotify account page).
- Concert sources: Ticketmaster free tier is ample; Songkick unverified.
- No LLM involvement in this feature — it is pure structured data.

## Follow-ups

- [ ] You: create the app, allowlist the account, set `SPOTIFY_CLIENT_ID`,
      run `python scripts/spotify_auth.py`. (Done — connected 2026-09-30;
      re-connected 2026-10-04 after tokens were lost in the repo move.
      First data point: short_term vs medium_term overlap 19 of 25.)
- [ ] Coverage check: partially done — see experiment 004 for the Spotify vs
      MusicBrainz release-calendar probe (Spotify scan pending rate-limit
      lift). The blend question got its first real data point: Tyla (a
      medium_term-only artist) had a Toronto concert the short_term list
      would have missed.
- [x] Concerts: decided — Ticketmaster Discovery, experiment 003.
- [x] Decide short_term vs blend (2026-10-04): **blend** — union of both
      windows by Spotify id + manual supplement (`blend_medium_term: true`).
      Deciding data: 19/25 overlap, and the 6 medium-only names are exactly
      the catalog artists the reissue-friendly lane wants (Beatles, Maroon 5,
      Elton John, Pussycat Dolls, Tate McRae). Tyla's concert (medium-only)
      was the original evidence. One extra top-artists call per run.
- [x] Decide: do concerts share the "Coming up" lane (tagged) or get their own
      lane? Decided in Phase 3 planning: **own lane** (locked default),
      implemented in 3D (experiment 017).
