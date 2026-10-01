import type { Budget, LlmStage, StageResult } from "@detox/core";

// LlmClient: one router interface (Backboard.io today, any OpenAI-compatible
// endpoint by base URL + key). Phase 0 ships the fake; the real client with
// batching queue, budget guard, and zod-validated structured outputs arrives
// in Phase 2. The fake costs nothing and records nothing.
export interface LlmClient {
  call(stage: string, model: string, prompt: string): Promise<StageResult<string>>;
}

export class FakeLlmClient implements LlmClient {
  async call(stage: string, model: string, _prompt: string): Promise<StageResult<string>> {
    return {
      output: `[stub ${stage}/${model}] believable fake digest line naming Stub Gazette.`,
      tokensIn: 0,
      tokensOut: 0,
      estCostUsd: 0,
      degraded: true,
      reason: "Phase 0 stub — no LLM calls",
    };
  }
}

// Templated digest fallback: the rules-only mode of the `digests` stage so
// the digest band never sits empty (plan §9.1 degradation path).
export function templateDigest(parts: { weather?: string; game?: string; urgent?: string }): string {
  const bits = [parts.weather, parts.game, parts.urgent].filter(Boolean);
  if (bits.length === 0) return "Good morning. Quiet start — nothing urgent yet.";
  return `Good morning. ${bits.join(" ")}`;
}

export function fakeStage<I>(name: string, model: string): LlmStage<I, string> {
  const client = new FakeLlmClient();
  return {
    name,
    model,
    mode: "rules-only",
    run: async (input: I[], _budget: Budget) =>
      client.call(name, model, JSON.stringify(input).slice(0, 200)),
  };
}
