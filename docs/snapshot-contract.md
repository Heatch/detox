# Snapshot contract (pipeline ↔ dashboard)

The frozen contract between `apps/pipeline` (writer) and `apps/dashboard`
(reader). The normative definition is the zod `SnapshotSchema` in
`packages/core/src/types.ts`; this document is the human-readable form.
Changes here require updating both sides in the same commit.

## Shape

```json
{
  "generatedAt": "2026-10-01T03-04-57.354Z",
  "runId": 6,
  "laneCounts": {
    "tech": { "shown": 5, "collected": 25 },
    "reddit-nba": { "shown": 5, "collected": 5 },
    "weather": { "shown": 3, "collected": 9 }
  },
  "digest": { "text": "Good morning. …", "generatedBy": "template" },
  "laneStatus": {
    "weather.envcan": { "ok": true, "note": null },
    "tech": { "ok": true, "note": null }
  },
  "lanes": {
    "tech": {
      "title": "Tech",
      "items": [
        {
          "id": "nf:123",
          "title": "Fifth unvaccinated person dies of measles",
          "summary": "State health officials race to vaccinate residents…",
          "meta": { "outlet": "arstechnica and 2 others", "age": "5 hours ago" },
          "url": "https://…"
        }
      ]
    },
    "reddit-nba": {
      "title": "r/nba",
      "items": [
        {
          "id": "rd:abc",
          "title": "[Karl Towns Sr.] …",
          "summary": null,
          "content": "full selftext of the post…",
          "comments": [{ "author": "u/whoever", "score": 5099, "body": "full comment body…" }],
          "meta": { "outlet": "r/nba", "age": "14 hours ago", "score": 7021, "comments": 1611 },
          "url": "https://reddit.com/…"
        }
      ]
    },
    "weather": {
      "title": "Weather",
      "defaultLocation": "toronto",
      "locations": [
        {
          "id": "toronto", "name": "Toronto",
          "context": "Mainly cloudy. 30 percent chance of showers…",
          "parts": [
            { "name": "Night", "consensus": 18.5,
              "sources": { "envcan": 18.5, "openmeteo": 17.8, "metno": 18.5 } }
          ],
          "spread": "Sources disagree tonight: 17.8° to 18.5°.",
          "week": [
            { "day": "Thursday", "date": "2026-10-01",
              "consensus": [21.4, 16.3],
              "sources": { "envcan": [23, 11], "openmeteo": [20.5, 16.3], "metno": [20, 15] },
              "spread": "20° to 23°" }
          ]
        }
      ]
    }
  },
  "cost": { "usdToday": 0, "capUsd": 0.05, "degraded": false }
}
```

## Field notes

- `generatedAt` — ISO UTC of assembly. `runId` — the `runs.id` that produced it.
- `laneCounts[lane]` — `{ shown, collected }`; drives the footer
  transparency line ("Selected N of M").
- `digest.generatedBy` — `llm` or `template`. The band never renders empty:
  `rules-only` mode falls back to the templated line. Phase 1 is always
  `template`, composed from the Toronto afternoon consensus and the top tech
  headline.
- `laneStatus` — per lane or per `lane.source` (`weather.envcan` etc.).
  `{ ok: false, note }` renders the §4 sentence in the lane ("Reddit listings
  did not respond at 9:04 pm (HTTP 403)."). Verified live in run 3, when a
  missing bearer token 403'd Reddit while every other lane rendered.
- `lanes` — keyed by `LaneId` (§5.3). Shapes differ per lane family:
  - item lanes (`tech`, `reddit-*`, stub lanes): `{ title, items[] }` where
    items carry `id/title/summary/meta/url` plus, for Reddit only,
    `content` (full selftext) and `comments[]` (`author/score/body`, full
    bodies). `summary` is nullable — Reddit has none by design (no LLM).
  - `weather`: `{ title, defaultLocation, locations[] }` with per-location
    `context` (EC textSummary), `parts[]` (`name/consensus/sources{}`),
    optional `spread` note, and `week[]` (day/date/consensus/sources/spread).
- `cost.usdToday` — sum of today's `llm_calls.est_cost_usd`; `degraded` is
  true when any stage ran rules-only over budget.
- Storage: `data/snapshots/<generatedAt>.json` plus `latest.json` (what the
  dashboard reads). History lives in SQLite; the JSON is the live contract.
