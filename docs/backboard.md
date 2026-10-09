# Backboard.io — reference for reuse in another project

Everything here was verified live against Backboard by this project
(experiment 013, 2026-10-04; see `docs/experiments/013-llm-providers.md`).
It exists so a second project can deploy the same integration without
re-discovering the contract.

**The one thing to internalize:** Backboard is **not an OpenAI-compatible
router**. It does not accept `POST /chat/completions` with a `Bearer` key.
It speaks its own threads API with an `X-API-Key` header. Treating it as
OpenAI-compatible is the mistake this project's original plan made.

---

## 1. Endpoints and auth

| | |
|---|---|
| Base URL | `https://app.backboard.io/api` |
| Chat | `POST {base}/threads/messages` |
| Auth | `X-API-Key: <BACKBOARD_API_KEY>` header (not `Authorization: Bearer`) |
| Model catalog | `GET {base}/models` (+ provider/model queries) |
| API key | From your Backboard account at `app.backboard.io`; store it as an env var (`BACKBOARD_API_KEY` in this project's `.env`, never committed) |

No OAuth flow is needed for completion calls — the API key alone works.

## 2. Request

```jsonc
POST https://app.backboard.io/api/threads/messages
Content-Type: application/json
X-API-Key: <key>

{
  "content": "user message / prompt body",
  "system_prompt": "optional system instructions",
  "llm_provider": "openai",          // which upstream provider to use
  "model_name": "gpt-5.6-luna",      // model id within that provider
  "json_output": true,               // structured-outputs flag
  "stream": false,
  "memory": "off",                   // keep stateless for one-shot calls
  "web_search": "off"
}
```

All fields except `content` are optional in practice; set `memory`/`web_search`
off for deterministic batch calls, `json_output: true` whenever the response
is parsed as JSON.

## 3. Response

```jsonc
{
  "content": "…text…",            // null on error
  "input_tokens": 123,
  "output_tokens": 456
}
```

Token counts are **real** (not estimates) — use them for cost accounting.

## 4. Minimal client (TypeScript)

```ts
export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export class BackboardProvider {
  constructor(
    private baseUrl: string,          // https://app.backboard.io/api
    private apiKey: string,
    private llmProvider = "openai",
    private fetchFn: typeof fetch = fetch
  ) {}

  async complete(req: {
    model: string;
    systemPrompt?: string;
    userContent: string;
    json?: boolean;
  }): Promise<LlmResponse> {
    const started = Date.now();
    const res = await this.fetchFn(`${this.baseUrl}/threads/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify({
        content: req.userContent,
        system_prompt: req.systemPrompt ?? undefined,
        llm_provider: this.llmProvider,
        model_name: req.model,
        json_output: req.json ?? false,
        stream: false,
        memory: "off",
        web_search: "off",
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const j = (await res.json()) as {
      content?: string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
    };
    return {
      text: j.content ?? "",
      tokensIn: typeof j.input_tokens === "number" ? j.input_tokens : 0,
      tokensOut: typeof j.output_tokens === "number" ? j.output_tokens : 0,
      latencyMs: Date.now() - started,
    };
  }
}
```

## 5. Config shape (what this project puts in `config/models.yaml`)

```yaml
providers:
  backboard:
    base_url: https://app.backboard.io/api
    key_env: BACKBOARD_API_KEY        # env var name, never the key itself
    transport: backboard-threads       # vs "openai-shim" for Google AI Studio
    llm_provider: openai               # upstream provider for model selection
    rpm: 500                           # observed Backboard ceiling
    requests_per_day: 10000

models:
  bulk: gemini-3.8-flash               # whatever your primary is
  interactive: gpt-5.6-luna            # Backboard-hosted model

model_providers:
  bulk: google-ai-studio
  interactive: backboard               # route this model key to Backboard

budget:
  daily_cap_usd: 0.05                  # dollars gate Backboard (it costs money)
```

Zod schema: `ProviderSchema` in `packages/core/src/types.ts`
(`base_url`, `key_env`, `transport`, `rpm`, `requests_per_day`,
`llm_provider`, `.passthrough()`).

## 6. Models and pricing (verified 2026-10-04)

- `gpt-5.6-luna` is served by Backboard under provider `openai`.
- **$0.20 / $1.20 per 1M input/output tokens**, ~1.05M-token context,
  JSON output supported, ~500 RPM.
- At this project's $0.05/day cap that buys ~250K input + 40K output
  tokens uncached — far more with cache hits (the project's own response
  cache means unchanged content never re-calls the API).
- Browse `GET {base}/models` for the full catalog (16,338 models at
  probe time).

## 7. Failure handling (the rules that matter)

| Failure | Behavior |
|---|---|
| HTTP 429 / 5xx | **Retry** — exponential backoff (1s, 2s, …), up to 2 retries |
| HTTP 400 / 401 / 404 | **Fail fast** — retrying burns budget; surface the error |
| Network error (fetch TypeError) | Retry (transient) |
| Provider refused (over budget) | Fall through to the next provider, then to rules-only/template output |
| Invalid JSON when `json_output: true` | Retry once with the validation error appended, then fall through |

Key the retry policy off `LlmHttpError` (status + `retryable` getter) as in
`packages/llm/src/providers.ts`.

## 8. Operational lessons from this project

- **Dollar-gate paid providers, request-gate free ones.** Backboard's token
  counts are real, so a per-provider pool (`spentUsdToday` vs
  `daily_cap_usd`) makes the guard honest; free tiers are capped on requests
  instead.
- **Cache aggressively.** `hash(stage version + content)` → stored output,
  30-day TTL. Cache hits must count toward *neither* cap (no dollars, no
  requests) — that's what makes rate limits painless.
- **Cost accounting must count failed attempts too.** A call that spends
  tokens and fails validation still counts toward the request cap; record it
  even though it produced nothing.
- **Batch before you call.** One call per run with 20–60 items beats
  per-item calls under any throttle. Size any output cap to the batch — a
  truncated JSON array was observed live (the Google AI Studio shim accepts
  `max_tokens`; the Backboard threads API as tested takes no such field, so
  control length via the prompt).
- **Backboard as fallback, not the default, when you have a free tier.**
  Route primary work through the free model and let Backboard absorb
  throttles — Gemini 503s are transient and fell through to Luna by design.

## 9. Quick deployment checklist for a new project

1. Register at `app.backboard.io`, create an app, copy the API key.
2. Put `BACKBOARD_API_KEY` in the environment (never in code or config files).
3. Drop in the provider class from §4 (or `packages/llm/src/providers.ts`).
4. Point one config entry at `base_url` + `key_env` and route your
   "interactive/fallback" model to `backboard`.
5. Verify with a JSON-output ping: send `json_output: true`, assert the
   response parses, and log `input_tokens`/`output_tokens` against a run row.
6. Wire the fallback chain: primary → Backboard → deterministic degraded
   output. Never let a provider outage block a run.
7. Set a daily dollar cap and a request cap before the first real workload,
   and confirm `GET {base}/models` lists your chosen model id.
