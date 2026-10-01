# 006 — Weather: three-source comparison for Waterloo, Vaughan, Toronto

Status: validated 2026-09-30 (all three sources keyless and working) | Revisit: 2027-01-01

## Question

Can we show today's temperature by day part (morning, afternoon, evening,
night) and a full 7-day outlook, compared across at least 3 independent
sources, with an easy toggle between Waterloo, Vaughan, and Toronto — in a
way that stays easy on the eyes?

## Candidates (from plan §9.2)

- **Environment Canada** — MSC GeoMet OGC API (`api.weather.gc.ca`).
- **Open-Meteo** — keyless point forecast, multi-model.
- **MET Norway** — `locationforecast/2.0`, keyless, User-Agent required.

## Method

Live probe 2026-09-30 for all three locations; each source fetched for the
same points; day parts computed as mean temperature over local hours
(morning 6–11, afternoon 12–17, evening 18–21, night 22–05); consensus =
median of the three sources. Design preview built against these real numbers:
`docs/weather-preview.html`.

## Result

**All three sources are viable and keyless** — no API key needed from you.

| Source | Endpoint | Coverage | Notes |
|---|---|---|---|
| Environment Canada | `GET api.weather.gc.ca/collections/citypageweather-realtime/items/{id}` | 24 hourly values + 13 day/night forecast periods (≈7 days) + current conditions, warnings, sunrise/sunset | Exact stations exist: Toronto `on-143`, Vaughan `on-64`, Kitchener-Waterloo `on-82`. Values are `{en, fr}` nested dicts. Hourly `timestamp` is a plain string (other fields are dicts — inconsistent). |
| Open-Meteo | `GET api.open-meteo.com/v1/forecast?latitude&longitude&hourly=temperature_2m&daily=...` | 168 hourly points (7 days) + 7 daily max/min, per exact lat/lon | Simplest payload of the three. Elevation-aware (Toronto 99 m, Vaughan 223 m, Waterloo 324 m). |
| MET Norway | `GET api.met.no/weatherapi/locationforecast/2.0/compact?lat&lon` | ~88 entries: hourly-ish for ~48 h, then 6-hourly out to ~9 days | Requires a descriptive User-Agent. **TLS outcome (Phase 1, 2026-10-01): Node/undici verifies fine — the Python cert-store failure does not apply.** No mitigation needed; plain `fetch` with the descriptive UA. |

**Sample (Toronto, Sep 30, day-part means):** afternoon EC 23° / Open-Meteo
21° / MET 21° — sources agree within 2°. Real disagreements showed up in the
overnight low (Waterloo night: 18° / 12° / 17°) and in day-4+ highs
(Oct 3–4 spread of 3–6° across sources). Exactly the behavior worth showing.

**Precipitation, wind, humidity (added 2026-09-30, second pass):** all three
sources provide them. Field map, verified live:

| Variable | Environment Canada | Open-Meteo | MET Norway |
|---|---|---|---|
| Precipitation | `lop` hourly (likelihood, % with category) | `precipitation` (mm) + `precipitation_probability` (%) hourly | `precipitation_amount` (mm) per `next_1_hours` (~59 h) and `next_6_hours` (~9 days) |
| Wind | hourly `wind.speed` (km/h) + `wind.direction` (compass + full name); period `winds` with bearing/speed and rank | `wind_speed_10m`, `wind_gusts_10m`, `wind_direction_10m` | `wind_speed`, `wind_from_direction` in `instant.details` |
| Humidity | period-level `relativeHumidity` (day/night) + `currentConditions.relativeHumidity` — **not hourly** | `relative_humidity_2m` hourly | `relative_humidity` in `instant.details` |

Notes:

- MET Norway's `probability_of_precipitation` was absent in this fetch
  (only `precipitation_amount` present) — treat pop as optional there; mm
  amounts are the reliable field.
- MET Norway instant details carry **no wind gusts** in this fetch; OM does.
- EC wind has no gust in hourly (period-level `winds` may include them in
  ranked periods).
- EC `textSummary` per period is a ready-made plain-language line ("A mix of
  sun and cloud. Wind becoming south 20 km/h this afternoon. High 23.
  Humidex 28. UV index 6 or high.") — useful as a lane context line without
  any LLM.
- Also available cheaply: EC `humidex`, `uv`; OM can add humidex/windchill
  per request; MET has `cloud_area_fraction`, `air_pressure_at_sea_level`.

**Data-shape quirks:**

- EC and MET Norway publish hourly values **from the current hour forward** —
  an afternoon snapshot has no "morning" row for them (Open-Meteo includes
  past hours of today). The 09:00 run captures the whole day for all three,
  so this is a snapshot artifact, not a gap in the design. Caching hourly
  values per run (the `weather_forecasts` table already plans this) fills
  anything missed.
- MET Norway degrades to 6-hourly after ~48 h — day-part means for later
  days come from coarser data than the first two days.
- EC's 7-day is day/night *periods* (13 entries → 6.5 days), not clean
  calendar days; Open-Meteo gives 7 clean days; MET Norway needs bucketing
  by local date.

## Decision

**All three sources in, per-location toggle over exact coordinates.** The
view (validated in `docs/weather-preview.html` against live numbers):

1. **Day parts as the hero** — four columns (morning, afternoon, evening,
   night), each showing the **median** in large serif, with the three
   source values stacked underneath in small tabular type. Comparison where
   it belongs: one number to read, three to check.
2. **7-day below** — one row per day, per-source high/low pairs, consensus
   column in gold. When sources disagree beyond the threshold
   (≥3 °C high or ≥25 pts precip, per `config/sources.yaml`), the consensus
   cell carries the spread in words ("15° to 18°") instead of a note
   elsewhere.
3. **Location pills** (Waterloo / Vaughan / Toronto) switch the whole block;
   locations are config-driven so adding one is a YAML edit.

Why this shape over a full table of all values all the time: the day-part
grid answers "what do I wear this afternoon" in one glance while keeping all
three sources one line away — no cards, no chart library, no info overload.

## Costs and limits

- All three APIs: free, no keys. EC and Open-Meteo accept plain GETs; MET
  Norway needs a proper User-Agent (and a working CA bundle).
- Rate limits are generous; a run is 3 locations × 3 sources = 9 requests.
- Config additions: `locations` list (name, lat/lon, EC station id) in
  `config/interests.yaml`; day-part hour ranges are constants documented
  here and in `config/settings.yaml`.

## Follow-ups

- [x] Precipitation/wind/humidity availability — answered above: all three
      sources provide all three variables (2026-09-30). Full field map moved
      into plan §9.2 as the lane's data contract, including EC `textSummary`
      as the lane context line. What remains is presentation: the current
      day-part layout takes too much space for what it shows, so the view
      needs a denser redesign before adding more rows.
- [ ] UI density pass on the weather block: same information in less space
      (the day-part grid + full 7-day is too tall). Consider folding source
      values into fewer lines, a compact 7-day strip, or progressive
      disclosure per part.
- [ ] Historical accuracy tracking (which source wins for GTA) — the plan's
      long-term experiment; Open-Meteo has a historical-forecast API to score
      against.
- [ ] Alerts lane: EC's `warnings` field is already in the payload.
- [ ] Adapter detail: pin api.met.no's CA or shell to curl on this host.
