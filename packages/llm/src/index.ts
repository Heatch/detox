import type { Budget, LlmStage, StageResult } from "@detox/core";

export * from "./providers.js";
export * from "./ratelimit.js";
export * from "./stages.js";

// LlmClient: the Phase 0 single-client interface. Phase 2 replaces it with
// the LlmProvider seam (experiment 013) — kept so existing imports compile.
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
