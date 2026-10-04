# 014 — Phase 3A news lanes: queries, corroboration gate, honest-empty

Status: decided 2026-10-04 | Revisit: Phase 4 query tuning

## Question

Four new Newsflash lanes (science, math, infrastructure, canada-gta) wired
end to end in 3A. Which queries, and what happens when a lane comes back
thin or empty?

## Candidates

- Per-lane queries as seeded in `sources.yaml` (semantic multi-term).
- Experiment 001's decision table (`q=Canada` keyword; infrastructure +
  named projects; math RSS-owned).

## Method

Live probes against `/events` (7 requests, free tier has ~65x headroom),
top-8 titles + confidence per query, same afternoon as first 3A run.

## Result

- **canada-gta: keyword wins.** `q=Canada` (no semantic) returned Carney,
  oilsands, Niagara Falls, Order of Canada, Pacific pipeline — genuinely
  national. The seeded `q="Canada Toronto Ontario" + semantic` returned
  data-centre deals and Danish/French leaks. Matches exp 001 exactly
  ("semantic is theme-blind to geography"). GTA hyperlocal stays a known
  gap → RSS gap-fillers (Phase 4).
- **infrastructure: named projects anchor the theme.** Seeded query mixed
  a $20bn software M&A deal into the lane. `q="infrastructure Ontario
  Line transit railway"` returned TTC Line 2 extension, Calgary–Edmonton
  HSR, Green Line LRT, rail tunnelling — theme-correct throughout, some
  UK/Australia rail accepted. "Ontario Line" already an entity in
  `interests.yaml`, so rules scoring reinforces it.
- **math: min_sources 3.** The seeded semantic query works on big-story
  days (OpenAI Millennium Problems, 18 sources; credit controversy, 14;
  Terence Tao) but 2-source semantic hits drift (golf). Exp 001's open
  2-vs-3 question resolves to 3 for math: corroborated-only. Category
  lanes (tech, science) stay at 2 — science runs thin already (2 events,
  both legit: phys.org agriculture, alpine lake).
- **relevance_floor is a dead knob.** `confidence = min(1, source_count/3)`,
  so the documented 0.35–0.40 floor filters nothing above 2 sources.
  min_sources is the real gate; the adapter still accepts relevance_floor
  but it should be retired or redefined (Phase 4).
- **Language filter has a hole.** `sources[].lang` is usually absent, and
  `englishOnly` passes lang-less events — French/Danish titles leak
  ("Attentat de la rue Copernic", "Canadas hovedstad", "OpenAI dit avoir
  résolu"). Documented as worse-than-expected; no cheap client-side fix
  without language detection (deferred, Phase 4).

## Decision

- `canada-gta: { q: "Canada" }`, `infrastructure: { q: "infrastructure
  Ontario Line transit railway", semantic: 1 }`, `math: { …, min_sources: 3 }`.
- **Omit `from` on q-lanes (`window_hours: 0`).** Follow-up probing proved
  `from` collapses semantic ranking to recency (math-with-`from` returned
  hackers, bug bounties, and a darts final; identical query without `from`
  returned the Millennium Problems). Category lanes keep `from=24h`, which
  behaves. Freshness for q-lanes comes from the pipeline instead:
- **7-day age cap on news lanes** (§9.6 open question, answered here):
  anything older than a week is stale curation, not news. Reddit lanes keep
  their own `time_window`.
- Math topic keywords gain `mathematics, mathematical, theorem` so fresh
  on-topic stories outscore fresh drift in rule selection.
- **Honest-empty rule:** any attempted Newsflash lane overwrites the stub
  scaffold even with zero keepers ("Selected 0 of N", plus the error note
  when errored). Stub Gazette content must never read as real news.
- Cross-lane dedupe confirmed free via `nf:<event_id>` identity (unit test:
  same event in tech+science keeps one, cluster size 2).
- Spaceflight stays out of Newsflash (§9.11) — moves to 3B with launches.

## Costs and limits

3A adds 4 Newsflash requests per run (5 total with tech). Morning run is
now ~20 requests against the 1,000/day free tier.

## Known limitations (Phase 4 tuning, needs news gold rows)

- **Weak-but-only picks surface.** First live run showed a crypto price
  prediction as the sole math item: real event, correctly fetched, poorly
  selected. Candidate machinery (score floors, per-lane negatives, topic
  gates) must be measured against labeled news rows first — tuning blind
  risks the tech lane, which currently selects well.
- **Non-English leaks** via the `sources[].lang` hole (above).
- **`relevance_floor` is accepted but unenforced** — wire it to
  `confidence` or retire it when the floor question is answered with data.
