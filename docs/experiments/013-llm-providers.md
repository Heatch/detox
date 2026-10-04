# 013 — Two LLM providers, not one router

Status: decided 2026-10-04 | Revisit: 2027-01-01

## Question

How do pipeline stages reach Gemini 3.8 Flash (bulk) and GPT-5.6 Luna
(fallback)? The plan assumed one `LlmClient` speaking a router's
OpenAI-compatible API, with Backboard as that router. Is that real?

## Candidates

1. Single OpenAI-compatible client pointed at Backboard (plan assumption).
2. Single OpenAI-compatible client pointed at Google AI Studio.
3. Two transports behind one `LlmProvider` seam.

## Method

Live probes with the repo's own `.env` keys (no secrets recorded here):

- `GET https://app.backboard.io/api/models` + provider/model queries
  (16,338 LLM models indexed at probe time).
- `GET https://generativelanguage.googleapis.com/v1beta/models`
  (x-goog-api-key auth) + `POST .../v1beta/openai/chat/completions`
  (Bearer auth, `response_format: {type: "json_object"}`).

## Result

- **Backboard is not OpenAI-compatible.** It speaks its own threads API:
  `POST {base}/threads/messages` with an `X-API-Key` header and per-message
  `llm_provider` + `model_name`. It returns real `input_tokens` /
  `output_tokens` and honors `json_output: true`. Base URL
  `https://app.backboard.io/api`.
- **Google AI Studio takes an OpenAI-style shim** (`{base}/chat/completions`,
  Bearer key, `response_format: json_object`). Usage arrives as
  `prompt_tokens` / `completion_tokens`. Base URL
  `https://generativelanguage.googleapis.com/v1beta/openai`.
- **Both configured model IDs are real.** `gemini-3.8-flash` completed a JSON
  probe (200, usage 11 in / 5 out). `gpt-5.6-luna` exists under Backboard
  provider `openai`: $0.20/$1.20 per 1M, ~1.05M context, JSON output
  supported — exactly the plan's pricing.
- **Gemini free-tier limits are 5 RPM *and* 30 RPD.** The plan documented
  only the former; 30/day is the binding constraint (~15 runs/day at two
  calls per run, shared with evals).
- **Gemini 503s are transient.** One probe returned 503 "high demand"; the
  immediate retry returned 200. Retry-then-fallback is load-bearing, not
  cosmetic. 4xx (400/401/404) fails fast — retrying those burns budget.

## Decision

Option 3: one `LlmProvider` interface (`packages/llm/src/providers.ts`),
two transports. Stages resolve model→provider from `config/models.yaml`
(`providers:` map + `model_providers:`). Per-provider budget pools:
Gemini gated on requests, Luna on dollars. Gemini first (free), Luna on
throttle/failure/starvation, template/rules-only last. `llm_cache` table,
30-day TTL, `hash(stage version + content)` keys; cached rows count toward
neither cap.

Rules-only taste baseline (tag-overlap scorer, `pnpm eval`, 42 gold rows):
precision@5 1.00, zero rejects in top 10, all three live-action drops at
the bottom. Rating tags (loved/liked/dropped/interested) are excluded from
scoring features — they encode the label. Known rules gaps for the LLM
stage to beat: uniquely-worded loved shows (Big Shot 0.32), short-note
shows (The Boys 0.50, Squid Game 0.48).

## Costs and limits

- Gemini: $0; 5 RPM (bucketed at 4), 30 RPD hard stop.
- Luna via Backboard: $0.20/$1.20 per 1M; $0.05/day guard; ~500 RPM.
- Backboard token counts are real, so the dollar guard accounts actuals.

## Open questions

- Digest gold rows don't exist yet (`pnpm eval` reports the gap). Draft
  candidates from real run highlights for 1–5 review before tuning the
  digest prompt.
- `tv.seen_shows` title spellings vs TMDB (Sterling Point, Off Campus,
  Big Shot, Upload, DAVE, Shrinking) surface at live-fetch time (Phase 3).
