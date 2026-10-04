// LlmProvider: one interface, two transports (experiment 013).
// google-ai-studio speaks an OpenAI-style shim (Bearer key); backboard speaks
// its own threads/messages API (X-API-Key header). Both report real token
// counts, which is what the budget guard accounts on. `fetchFn` is injectable
// so stages are unit-testable without network.

export interface LlmRequest {
  model: string;
  systemPrompt?: string;
  userContent: string;
  json?: boolean;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface LlmProvider {
  id: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type FetchFn = typeof fetch;

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`HTTP ${status}: ${body}`);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Google AI Studio via the OpenAI-compatible shim (experiment 013, probed live). */
export class GoogleAIStudioProvider implements LlmProvider {
  readonly id = "google-ai-studio";
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchFn: FetchFn = fetch
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const messages: { role: string; content: string }[] = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    messages.push({ role: "user", content: req.userContent });
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      }),
    });
    if (!res.ok) throw new LlmHttpError(res.status, (await res.text()).slice(0, 300));
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, unknown>;
      model?: string;
    };
    const text = j.choices?.[0]?.message?.content ?? "";
    const usage = j.usage ?? {};
    return {
      text,
      tokensIn: num(usage.prompt_tokens ?? usage.promptTokens),
      tokensOut: num(usage.completion_tokens ?? usage.completionTokens),
      latencyMs: Date.now() - started,
    };
  }
}

/** Backboard threads/messages API (experiment 013, contract from published OpenAPI). */
export class BackboardProvider implements LlmProvider {
  readonly id = "backboard";
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private llmProvider = "openai",
    private fetchFn: FetchFn = fetch
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
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
    if (!res.ok) throw new LlmHttpError(res.status, (await res.text()).slice(0, 300));
    const j = (await res.json()) as {
      content?: string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
    };
    return {
      text: j.content ?? "",
      tokensIn: num(j.input_tokens),
      tokensOut: num(j.output_tokens),
      latencyMs: Date.now() - started,
    };
  }
}
