# 012 — Games: Steam wishlist + ITAD sale prices

Status: validated 2026-09-30 (wishlist chain keyless; ITAD awaits API key) | Revisit: on key arrival

## Question

New feature: show when games on my Steam wishlist are on sale — old price,
new price, % off — using the free ITAD (IsThereAnyDeal) API. The wishlist
comes from a configurable username
(`store.steampowered.com/wishlist/id/Bitesh9/` today).

## Method

Live probes 2026-09-30: Steam vanity resolution, every known wishlist JSON
endpoint (keyless), Steam appdetails for identity+price, and ITAD endpoint
discovery by probing paths/methods keyless (auth-layer errors reveal which
shapes exist).

## Result

**Steam wishlist — fully workable keyless.** The legacy
`/wishlist/id/{user}/wishlistdata/` returns the store homepage (dead). The
working chain:

1. **Vanity → steamid64**: `GET steamcommunity.com/id/{username}?xml=1`
   → `<steamID64>` (Bitesh9 → `76561198281447958`). The `?xml=1` profile
   probe is the resolution step; the username in config is all that changes.
2. **Wishlist**: `GET api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid={id}`
   — **keyless JSON**: `[{appid, priority, date_added}]`. Bitesh9's list
   returns 3 games: Satisfactory (526870), Deep Rock Galactic (548430),
   Plants vs. Zombies: Replant (3654560). Priorities are the user's manual
   ordering — useful as a sort key.
3. **Identity + Steam price (keyless)**: `GET
   store.steampowered.com/api/appdetails?appids={id}&cc=ca&l=en` → name,
   release date, `price_overview` (final/initial/discount_percent). Verified:
   Satisfactory "CDN$ 36.39, 30% off from CDN$ 51.99". This alone could
   power a Steam-only sale lane.

**ITAD — mapped, one credential short.** Error-shape probing and the official
OpenAPI spec pin the surface (403 "Missing api key" = shape exists; 405 =
wrong method; 404 = dead path). **Auth finding (2026-09-30)**: app
registration generates *three* credentials — `client_id`, `client_secret`
(the OAuth pair, for user-scope endpoints like waitlist sync — not needed
here), and a separate **API key** which is what `prices`/`lookup`/`info`
take (`?key=` or `ITAD-API-Key` header). `.env` currently has the OAuth pair
(`ITAD_ID`/`ITAD_SECRET`) — every auth form tested with them was rejected
("Invalid or expired api key"), so the API key itself is still needed from
the same "My Apps" page.

| Endpoint | Method | Status |
|---|---|---|
| `/games/prices/v3` | **POST** (GET → 405) | the prices workhorse: `country`, `currency`, `deals` (sale-only filter), `shops`, `capacity`; per-game price/regular/cut per shop |
| `/games/overview/v2` | **POST** | overview + historical lows (`historyLow`, 3-month and 1-year lows — per their changelog) |
| `/games/info/v2` | GET | game info |
| `/service/shops/v1` | GET | **keyless 200** — shop ID list (AllYouPlay etc.) for display names |
| `/game/plain/v2`, `/search/v1`, `/service/game/v1` | — | dead paths, don't use |

Game IDs use the `steam/app/{appid}` form (seen in the prices/v3 query
shaped probe). Per the changelog: `deals=true` returns only discounted
prices (exactly the lane's filter), vouchers optional, and OAuth can replace
the key later for ITAD-native waitlists — not needed since the Steam
wishlist chain works keyless.

## Decision

**Games lane: Steam wishlist (keyless) + ITAD prices (API key), universal
lowest price, with Steam prices as the fallback.** Per run:

1. Resolve username → steamid64 (cache forever — vanity changes are rare).
2. Fetch wishlist appids (keyless), sort by `priority`.
3. `appdetails` per appid for names + Steam-side price (keyless).
4. **appid → ITAD UUID**: `POST /lookup/id/shop/61/v1` (Steam = shop 61) with
   the appid list — keyless, verified live.
5. `POST /games/prices/v3` (API key) with the UUID array
   (`country=CA&currency=CAD`, `deals=true`): **the sale row is the minimum
   `deals[].price` across ALL covered shops** — never shop-assumed — shown
   with the winning `shop.name`; old price = that shop's `regular`, % off =
   `cut`, plus `storeLow`/`historyLow` for context. `deals=true` means the
   lane only lists actual discounts. Rank by deepest cut, then wishlist
   priority.
6. **Fallback**: if ITAD is unreachable/unkeyed, the lane degrades to
   Steam-store discounts only (appdetails already carries % off) and says so.

Config (`interests.yaml`): `games.steam_username: Bitesh9`, `country: CA`,
`currency: CAD`, `deals_only: true`. `sources.yaml` carries the endpoints.

## Costs and limits

- Steam chain: keyless, 1 resolve + 1 wishlist + 1 appdetails per game per
  run (3 games today — trivial).
- ITAD: free API key by registering an app at isthereanydeal.com/apps
  ("My Apps" page — regular account, register app, keys generated). Sent as
  `?key=` (auth layer says "Missing api key"). Rate limits undocumented in
  my probes; our volume (a handful of POSTs per run) is far below anything
  interesting.

## Follow-ups

- [x] **Universal-lowest semantics verified (2026-09-30)** — the prices/v3
      response schema (official OpenAPI) returns `deals[]` across **all
      covered shops**, each with `price`, `regular`, `cut` (% off),
      `storeLow`, `expiry`, `url`; `historyLow: {all, y1, m3}` sits at game
      level. `POST /games/overview/v2` explicitly returns "current best
      price … historical low (among all covered shops)". So the sale row =
      **min `deals[].price` across shops** (not Steam's), displayed with the
      winning `shop.name`; old price = that shop's `regular`, % off = `cut`.
      Verified design decision: universal lowest, never shop-assumed.
- [x] **ID mapping step discovered** — `prices/v3` takes ITAD UUIDs (plain
      uuid array body), NOT `steam/app/{appid}`. The mapping is
      `POST /lookup/id/shop/61/v1` (shop 61 = Steam) with
      `["app/526870", …]` — **works keyless** (verified live: all 3 wishlist
      appids → UUIDs). Batchable up to 200.
- [x] **API key verified end-to-end (2026-09-30)** — live `prices/v3` round-trip
      on the real wishlist: Satisfactory's universal lowest is Steam CDN$
      36.39 (30% off, expires Oct 1) and Deep Rock Galactic's is **GamesPlanet
      US $40.54 (5% off) — not Steam**, exactly the universal-lowest
      requirement. `historyLow` present per game (Satisfactory all-time
      18.69). Two quirks from the live run: (1) `deals=true` **omits games
      with no deals from the response** (3 UUIDs requested → 2 returned) —
      the lane must union the response against the wishlist, not treat it as
      the game list; (2) `historyLow` amounts need their `currency` field
      checked before comparing against deal prices. Env var name is
      `ITAD_KEY`.
- [ ] Historical-low display: "new historical low" flag when the sale price
      beats `historyLow.all`.
- [ ] Unreleased/wishlist items with no price yet — render "TBA" rows or
      hide?
- [ ] Vouchers (`vouchers` param) — include or keep to clean prices?
