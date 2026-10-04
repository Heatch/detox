import type { LlmMode, ProviderPool } from "./types.js";

export interface GuardDecision {
  allowed: boolean;
  degraded: boolean;
  reason?: string;
}

// Budget guard: before each stage, check the pool that binds for that
// provider — dollars for Luna/Backboard, request count for Gemini
// (experiment 013). Over cap → rules-only degradation, never a blocked run.
export function checkBudget(
  pool: ProviderPool,
  stageMode: LlmMode,
  estimatedCostUsd: number
): GuardDecision {
  if (stageMode === "off") return { allowed: false, degraded: true, reason: "stage off" };
  if (stageMode === "rules-only") return { allowed: false, degraded: true, reason: "stage rules-only" };
  if (pool.spentUsdToday + estimatedCostUsd > pool.dailyCapUsd) {
    return {
      allowed: false,
      degraded: true,
      reason: `over daily cap $${pool.dailyCapUsd} (spent $${pool.spentUsdToday.toFixed(4)})`,
    };
  }
  if (pool.requestsToday >= pool.requestsPerDayCap) {
    return {
      allowed: false,
      degraded: true,
      reason: `over daily request cap ${pool.requestsPerDayCap}`,
    };
  }
  return { allowed: true, degraded: false };
}

export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  pricePerMTokIn: number,
  pricePerMTokOut: number
): number {
  return (tokensIn / 1_000_000) * pricePerMTokIn + (tokensOut / 1_000_000) * pricePerMTokOut;
}
