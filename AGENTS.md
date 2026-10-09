# Detox — agent guide

Read this file first. It is the entry point; everything that governs this project lives under `docs/`.

## What this is

A personal, local-first morning dashboard. A TypeScript pipeline collects news, weather, sports, entertainment releases, Reddit, and holdings data on your machine; an LLM layer curates each lane down to a few strong items; an Astro site renders the result on localhost. Details in `docs/architecture-plan.md`.

## Document map

| Path | What it governs |
|---|---|
| `docs/architecture-plan.md` | System design, data model, pipeline stages, per-feature outlines, roadmap. Start here for any structural change. |
| `docs/style-guide.md` | The visual system: palette, type, spacing, components, written voice. Binding for all UI work. |
| `docs/anti-ai-design-decisions.md` | The filter applied after the style guide. Never overridden by it. |
| `docs/style-preview.html` | Reference implementation of the style, with fictional content. When preview and guide disagree, fix one deliberately. |
| `docs/weather-preview.html` | Weather block design with live 3-source data (experiment 006). |
| `config/interests.yaml` | The preference file: topics, keywords, lane budget, teams, watchlist, music, concerts, Reddit subs/limits, negative filters. User-edited; drives queries and scoring. |
| `config/settings.yaml` | Runtime: timezone, refresh contract, windows, LLM cap, audit retention. |
| `config/sources.yaml` | Source definitions per family: endpoints, query shapes, rate limits, tier weights. |
| `config/models.yaml` | LLM stages: model per stage, `off / rules-only / llm` modes, budget guard. |
| `config/holdings.md` | Tickers for the Holdings lane. User-edited; read on every pipeline run. |
| `docs/experiments/` | Decision records for every API, SDK, and model choice. |
| `docs/backboard.md` | Backboard.io reference: not OpenAI-compatible, threads API contract, auth, pricing, failure rules — everything needed to redeploy it in another project. |

## Rules for working in this repo

1. **Keep the architecture flexible.** Sources sit behind the `SourceAdapter` interface, LLM work behind pluggable stages. No API, model, or feed list is a settled decision unless an experiment record says so. Adding a source means adding an adapter and a config entry, not editing the pipeline.
2. **Rules first, LLM second.** Deterministic code does scoring, sorting, dedupe candidates, and consensus math. Every LLM stage must work in `off | rules-only | llm` modes, and the dashboard must render usefully with the LLM disabled.
3. **Curation is a budget.** Lanes show 3–5 strong, well-sourced items. Cut items are retained with reasons, never silently dropped. Do not widen a lane to fill space.
4. **UI work passes two documents.** `docs/style-guide.md` and the review checklist in `docs/anti-ai-design-decisions.md` §6. Watch the drift list in §5 of that document.
5. **Voice applies to generated text too.** One-line summaries: max 25 words, plain sentence case, claim attributed to a named outlet, no emphasis typography.
6. **Local-first.** No external hosting, no telemetry. Keys stay in the gitignored `.env`. Data lives in SQLite and `data/`.
7. **Record decisions.** Any "which API do we use" choice gets a `docs/experiments/NNN-name.md` record with the numbers behind it (template in the plan, §13).

## Working state

The project is in Phase 2 (LLM layer, experiment 013): two providers behind the `LlmProvider` seam — Google AI Studio (`gemini-3.8-flash`, free, 5 RPM / 30 RPD) for bulk and Backboard (`gpt-5.6-luna` via provider `openai`, $0.05/day) for fallback. Live stages are `digests` (LLM with template fallback) and `taste` (rules tag-overlap + LLM `{id, confidence, reason}`; no live candidates until the Phase 3 TMDB adapter, exercised via `pnpm eval`). Tech select/summarize stay rules-only (experiment 001); Reddit stays LLM-free (2026-10-01). `tv.seen_shows` is seeded (30 shows); `evals/gold.jsonl` holds 42 taste rows (23 yes / 12 maybe / 7 no). Phase 3A done (experiment 014): science, math, infrastructure, canada-gta live via Newsflash, rules-only — 9 of 15 lanes real. Phase 3B done (experiment 015): Raptors schedule + injuries via ESPN, spaceflight news, next-5 launches — 12 of 15 lanes real. Phase 3C done (experiment 016): Holdings news live via Yahoo RSS with promo cuts; earnings live via quote-page fallback (crumb throttled) — 5 upcoming dates + thin-data row verified. Phase 3D done (experiment 017): TMDB movies + TV seasons + live taste reasons, 3 concerts, 3 discounted games — music releases pending a MusicBrainz unblock, self-fills on a later run. Phase 4 done (experiment 018): weather scoring shows consensus winning everywhere, artist blend decided, digest feedback capture live. All 15 lanes wired; tuning passes per feature from here. Open user tasks: seed `movies.people` (done — 44 names), review digest gold candidates (none exist yet). Note: `config/` and `evals/` are git-untracked (portfolio, taste profile, and gold set stay local).
