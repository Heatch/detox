import type { Budget, LlmMode } from "./types.js";

export interface GuardDecision {
  allowed: boolean;
  degraded: boolean;
  reason?: string;
}

// Budget guard: before each stage, check dollars AND request count.
// Over cap → rules-only degradation, never a blocked run.
export function checkBudget(
  budget: Budget,
  stageMode: LlmMode,
  estimatedCostUsd: number
): GuardDecision {
  if (stageMode === "off") return { allowed: false, degraded: true, reason: "stage off" };
  if (stageMode === "rules-only") return { allowed: false, degraded: true, reason: "stage rules-only" };
  if (budget.spentUsdToday + estimatedCostUsd > budget.dailyCapUsd) {
    return {
      allowed: false,
      degraded: true,
      reason: `over daily cap $${budget.dailyCapUsd} (spent $${budget.spentUsdToday.toFixed(4)})`,
    };
  }
  if (budget.requestsToday >= budget.requestsPerDayCap) {
    return {
      allowed: false,
      degraded: true,
      reason: `over daily request cap ${budget.requestsPerDayCap}`,
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
