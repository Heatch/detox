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
| `config/holdings.md` | Tickers for the Holdings lane. User-edited; read on every pipeline run. |
| `docs/experiments/` | Decision records for every API, SDK, and model choice. |

## Rules for working in this repo

1. **Keep the architecture flexible.** Sources sit behind the `SourceAdapter` interface, LLM work behind pluggable stages. No API, model, or feed list is a settled decision unless an experiment record says so. Adding a source means adding an adapter and a config entry, not editing the pipeline.
2. **Rules first, LLM second.** Deterministic code does scoring, sorting, dedupe candidates, and consensus math. Every LLM stage must work in `off | rules-only | llm` modes, and the dashboard must render usefully with the LLM disabled.
3. **Curation is a budget.** Lanes show 3–5 strong, well-sourced items. Cut items are retained with reasons, never silently dropped. Do not widen a lane to fill space.
4. **UI work passes two documents.** `docs/style-guide.md` and the review checklist in `docs/anti-ai-design-decisions.md` §6. Watch the drift list in §5 of that document.
5. **Voice applies to generated text too.** One-line summaries: max 25 words, plain sentence case, claim attributed to a named outlet, no emphasis typography.
6. **Local-first.** No external hosting, no telemetry. Keys stay in the gitignored `.env`. Data lives in SQLite and `data/`.
7. **Record decisions.** Any "which API do we use" choice gets a `docs/experiments/NNN-name.md` record with the numbers behind it (template in the plan, §13).

## Working state

The project is at planning stage: `docs/` and `config/holdings.md` exist; `packages/`, `apps/`, and `data/` from the plan's repo layout are not built yet. Follow the roadmap phases in the plan; Phase 0 is scaffolding.
