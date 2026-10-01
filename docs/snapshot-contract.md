# Snapshot contract (pipeline ↔ dashboard)

The frozen contract between `apps/pipeline` (writer) and `apps/dashboard`
(reader). The normative definition is the zod `SnapshotSchema` in
`packages/core/src/types.ts`; this document is the human-readable form.
Changes here require updating both sides in the same commit.

## Shape

```json
{
  "generatedAt": "2026-10-01T01:30:39.021Z",
  "runId": 2,
  "laneCounts": {
    "tech": { "shown": 3, "collected": 34 }
  },
  "digest": { "text": "Good morning. …", "generatedBy": "template" },
  "lanes": {
    "tech": {
      "title": "Tech",
      "items": [
        {
          "id": "stub-t1",
          "title": "Postgres 19 ships with native columnar storage",
          "summary": "One-line summary, 25 words max, outlet named.",
          "meta": { "outlet": "Stub Gazette", "age": "3 hours ago" },
          "url": "https://example.test/tech/1",
          "score": {}
        }
      ]
    },
    "weather": {
      "title": "Weather",
      "context": "A mix of sun and cloud. High 23.",
      "locations": ["Toronto"],
      "parts": [
        { "name": "Morning", "consensus": 16, "sources": [null, 16, null] }
      ]
    }
  },
  "cost": { "usdToday": 0.011, "capUsd": 0.05, "degraded": false }
}
```

## Field notes

- `generatedAt` — ISO UTC of assembly. `runId` — the `runs.id` that produced it.
- `laneCounts[lane]` — `{ shown, collected }`; drives the footer
  transparency line ("Selected N of M").
- `digest.generatedBy` — `llm` or `template`. The band never renders empty:
  `rules-only` mode falls back to the templated line.
- `lanes` — keyed by `LaneId` (§5.3). Shapes differ per lane family
  (item lists vs weather tables vs sports blocks); each lane documents its
  own shape in its experiment record.
- `cost.usdToday` — sum of today's `llm_calls.est_cost_usd`; `degraded` is
  true when any stage ran rules-only over budget.
- Storage: `data/snapshots/<generatedAt>.json` plus `latest.json` (what the
  dashboard reads). History lives in SQLite; the JSON is the live contract.
