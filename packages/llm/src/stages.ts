import { createHash } from "node:crypto";
import { z } from "zod";
import {
  callsToday,
  checkBudget,
  estimateCostUsd,
  getLlmCache,
  recordLlmCall,
  setLlmCache,
  spendTodayUsd,
  type Budget,
  type Db,
  type LlmMode,
  type Models,
  type ProviderPool,
} from "@detox/core";
import { BackboardProvider, GoogleAIStudioProvider, type FetchFn, type LlmProvider } from "./providers.js";
import { takeToken, withBackoff } from "./ratelimit.js";

// Templated digest fallback: the rules-only mode of the `digests` stage so
// the digest band never sits empty (plan §9.1 degradation path).
export function templateDigest(parts: { weather?: string; game?: string; urgent?: string }): string {
  const bits = [parts.weather, parts.game, parts.urgent].filter(Boolean);
  if (bits.length === 0) return "Good morning. Quiet start — nothing urgent yet.";
  return `Good morning. ${bits.join(" ")}`;
}

// --- stage → (model, provider) resolution ---------------------------------

export interface StageTarget {
  modelKey: string;
  model: string;
  providerId: string;
}

export function resolveStageTarget(models: Models, stage: keyof Models["stages"]): StageTarget {
  const cfg = models.stages[stage];
  const providersByKey = models.model_providers as Record<string, string>;
  const namesByKey = models.models as Record<string, string>;
  const providerId = providersByKey[cfg.model] ?? (cfg.model === "interactive" ? "backboard" : "google-ai-studio");
  const model = namesByKey[cfg.model] ?? cfg.model;
  return { modelKey: cfg.model, model, providerId };
}

// --- provider construction -------------------------------------------------

export const LUNA_PRICE_PER_MTOK_IN = 0.2;
export const LUNA_PRICE_PER_MTOK_OUT = 1.2;

export function buildProviders(
  env: Record<string, string>,
  models: Models,
  fetchFn?: FetchFn
): Map<string, LlmProvider> {
  const out = new Map<string, LlmProvider>();
  for (const [id, p] of Object.entries(models.providers)) {
    const key = env[p.key_env] ?? "";
    if (!key) continue; // missing key = provider unavailable; stages fall through
    if (p.transport === "openai-shim") out.set(id, new GoogleAIStudioProvider(p.base_url, key, fetchFn));
    else if (p.transport === "backboard-threads")
      out.set(id, new BackboardProvider(p.base_url, key, p.llm_provider ?? "openai", fetchFn));
  }
  return out;
}

// --- per-provider budget pools ---------------------------------------------

export function buildBudget(db: Db, dayPrefix: string, models: Models): Budget {
  const pools: Record<string, ProviderPool> = {};
  for (const [id, p] of Object.entries(models.providers)) {
    pools[id] = {
      // Dollars bind Luna/Backboard; Gemini costs $0 so its cap is 0 and the
      // request counter is the real gate (experiment 013).
      dailyCapUsd: id === "backboard" ? models.budget.daily_cap_usd : 0,
      spentUsdToday: spendTodayUsd(db, dayPrefix, id),
      requestsToday: callsToday(db, dayPrefix, id),
      requestsPerDayCap: p.requests_per_day,
      rpm: p.rpm,
    };
  }
  return { pools };
}

// --- generic zod-validated JSON stage --------------------------------------

export interface ProviderRef {
  provider: LlmProvider;
  providerId: string;
  model: string;
  pool: ProviderPool;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
}

export function providerRef(
  providers: Map<string, LlmProvider>,
  budget: Budget,
  providerId: string,
  model: string
): ProviderRef | undefined {
  const provider = providers.get(providerId);
  const pool = budget.pools[providerId];
  if (!provider || !pool) return undefined;
  const paid = providerId === "backboard";
  return {
    provider,
    providerId,
    model,
    pool,
    pricePerMTokIn: paid ? LUNA_PRICE_PER_MTOK_IN : 0,
    pricePerMTokOut: paid ? LUNA_PRICE_PER_MTOK_OUT : 0,
  };
}

export interface JsonStageResult<T> {
  output?: T;
  degraded: boolean;
  reason?: string;
  providerId?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function stageCacheKey(version: string, payload: unknown): string {
  return `stage:${version}:` + createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 32);
}

export function parseJsonStrict(text: string): unknown {
  const unfenced = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`non-JSON output: ${text.slice(0, 160)}`);
  }
}

export interface JsonStageDeps<T> {
  db: Db;
  runId: number;
  stage: string;
  version: string;
  mode: LlmMode;
  cachePayload: unknown;
  cacheTtlDays: number;
  buildPrompt: () => { system: string; user: string; maxTokens?: number };
  schema: z.ZodType<T>;
  refs: ProviderRef[];
  log?: (msg: string) => void;
}

/**
 * runJsonStage — cache → guard → throttle → call → validate.
 * Invalid output is retried once with the validation error appended, then
 * falls through to the next provider ref. Every real call updates its pool
 * in place so sequential stages in one run share the budget. Returns
 * degraded (never throws) when every path refuses — the caller degrades to
 * rules-only and says so.
 */
export async function runJsonStage<T>(deps: JsonStageDeps<T>): Promise<JsonStageResult<T>> {
  const { db, runId, stage, version, mode, cachePayload, cacheTtlDays, buildPrompt, schema, refs } = deps;
  const log = deps.log ?? (() => {});
  const key = stageCacheKey(version, cachePayload);

  const cached = getLlmCache(db, key, cacheTtlDays);
  if (cached) {
    try {
      const output = schema.parse(JSON.parse(cached.output_json));
      recordLlmCall(db, {
        run_id: runId,
        stage,
        model: "cache",
        provider: refs[0]?.providerId ?? "cache",
        tokens_in: cached.tokens_in,
        tokens_out: cached.tokens_out,
        cache_hit: 1,
        est_cost_usd: 0,
      });
      return { output, degraded: false, tokensIn: cached.tokens_in, tokensOut: cached.tokens_out, cacheHit: true };
    } catch {
      // stale/invalid cache entry — fall through to a live call
    }
  }

  if (mode !== "llm") return { degraded: true, reason: `stage ${mode}`, tokensIn: 0, tokensOut: 0, cacheHit: false };

  const failures: string[] = [];
  for (const ref of refs) {
    const guard = checkBudget(ref.pool, mode, 0);
    if (!guard.allowed) {
      failures.push(`${ref.providerId}: ${guard.reason}`);
      log(`[${stage}] ${ref.providerId} refused: ${guard.reason}`);
      continue;
    }
    await takeToken(ref.providerId, ref.pool.rpm);
    const { system, user, maxTokens } = buildPrompt();
    const completeOnce = (userContent: string) =>
      withBackoff(() =>
        ref.provider.complete({ model: ref.model, systemPrompt: system, userContent, json: true, maxTokens })
      );
    try {
      // Transport errors (after backoff) fall through to the next provider.
      // Only invalid output gets the one validation-error retry.
      const resp = await completeOnce(user);
      let output: T;
      try {
        output = schema.parse(parseJsonStrict(resp.text)) as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[${stage}] ${ref.providerId} first attempt invalid, retrying: ${msg.slice(0, 160)}`);
        // The failed attempt spent real quota (and, on Luna, real cents) —
        // record it so the caps stay honest, then retry once.
        const failedCost = estimateCostUsd(resp.tokensIn, resp.tokensOut, ref.pricePerMTokIn, ref.pricePerMTokOut);
        ref.pool.requestsToday += 1;
        ref.pool.spentUsdToday += failedCost;
        recordLlmCall(db, {
          run_id: runId,
          stage,
          model: ref.model,
          provider: ref.providerId,
          tokens_in: resp.tokensIn,
          tokens_out: resp.tokensOut,
          latency_ms: resp.latencyMs,
          est_cost_usd: failedCost,
        });
        const retry = await completeOnce(
          `${user}\n\nPrevious output was invalid: ${msg.slice(0, 300)}. Reply with valid JSON only.`
        );
        output = schema.parse(parseJsonStrict(retry.text)) as T;
        resp.tokensIn += retry.tokensIn;
        resp.tokensOut += retry.tokensOut;
        resp.latencyMs += retry.latencyMs;
      }
      const cost = estimateCostUsd(resp.tokensIn, resp.tokensOut, ref.pricePerMTokIn, ref.pricePerMTokOut);
      ref.pool.requestsToday += 1;
      ref.pool.spentUsdToday += cost;
      setLlmCache(db, key, stage, JSON.stringify(output), resp.tokensIn, resp.tokensOut, new Date().toISOString());
      recordLlmCall(db, {
        run_id: runId,
        stage,
        model: ref.model,
        provider: ref.providerId,
        tokens_in: resp.tokensIn,
        tokens_out: resp.tokensOut,
        latency_ms: resp.latencyMs,
        est_cost_usd: cost,
      });
      return {
        output,
        degraded: false,
        providerId: ref.providerId,
        model: ref.model,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        cacheHit: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The attempt consumed provider quota even though it produced nothing,
      // so it counts toward the request cap (but never toward spend).
      ref.pool.requestsToday += 1;
      recordLlmCall(db, {
        run_id: runId,
        stage,
        model: ref.model,
        provider: ref.providerId,
        tokens_in: 0,
        tokens_out: 0,
        est_cost_usd: 0,
      });
      failures.push(`${ref.providerId}: ${msg.slice(0, 160)}`);
      log(`[${stage}] ${ref.providerId} failed: ${msg.slice(0, 200)}`);
    }
  }
  return { degraded: true, reason: failures.join(" | ") || "no providers configured", tokensIn: 0, tokensOut: 0, cacheHit: false };
}

// --- digests stage ----------------------------------------------------------

export const DigestOutputSchema = z.object({ text: z.string().min(1).max(500) });
export type DigestOutput = z.infer<typeof DigestOutputSchema>;

export interface DigestInput {
  weather?: string;
  game?: string;
  urgent?: string;
  counts?: string;
}

export function buildDigestPrompt(input: DigestInput): { system: string; user: string; maxTokens?: number } {
  return {
    system:
      "You write a two-sentence morning briefing for a personal dashboard. Plain sentence case, no emphasis typography, no greeting beyond the given opener. Name the source of each claim. Reply with JSON only: {\"text\": \"...\"}.",
    user: `Write the briefing from these highlights:\n${JSON.stringify(input, null, 2)}`,
    maxTokens: 200,
  };
}

export interface DigestResult {
  text: string;
  generatedBy: "llm" | "template";
  providerId?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  reason?: string;
}

export async function runDigestStage(deps: {
  db: Db;
  runId: number;
  input: DigestInput;
  mode: LlmMode;
  cacheTtlDays: number;
  refs: ProviderRef[];
  log?: (msg: string) => void;
}): Promise<DigestResult> {
  const r = await runJsonStage<DigestOutput>({
    ...deps,
    stage: "digests",
    version: "digests/v1",
    cachePayload: deps.input,
    buildPrompt: () => buildDigestPrompt(deps.input),
    schema: DigestOutputSchema,
  });
  if (r.output) {
    return {
      text: r.output.text,
      generatedBy: "llm",
      providerId: r.providerId,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheHit: r.cacheHit,
    };
  }
  return {
    text: templateDigest({ weather: deps.input.weather, game: deps.input.game, urgent: deps.input.urgent }),
    generatedBy: "template",
    tokensIn: 0,
    tokensOut: 0,
    cacheHit: false,
    reason: r.reason,
  };
}

// --- taste stage ------------------------------------------------------------

export interface TasteCandidate {
  id: string;
  title: string;
  tags?: string[];
  notes?: string;
}

export interface TasteProfile {
  loved: TasteCandidate[];
  disliked: TasteCandidate[];
  excludedIds: string[];
}

export interface TasteScore {
  id: string;
  confidence: number;
  reason: string;
}

export const TasteOutputSchema = z.object({
  picks: z.array(
    // Reasons cap at 280 for the model (it ignores tighter caps); display
    // truncates to 140 with an ellipsis (voice: one line).
    z.object({ id: z.string(), confidence: z.number().min(0).max(1), reason: z.string().min(1).max(280) })
  ),
});

const TASTE_STOP = new Set(
  "the,a,an,and,of,to,in,is,it,was,for,with,as,but,more,than,just,really,very,pretty,quite,overall,probably,another,one,my,me,like,they,them,this,that,its,itself,from,into,over,under,than,too,also,only,even,ever,never,always,all,any,some,show,shows,series,season,watch,watching,watched,loved,liked,good,great,solid,fun,enjoyable,pretty".split(
    ","
  )
);

// Rating tags (loved/liked/dropped/interested) encode the LABEL, not taste —
// scoring on them is circular. Behavioral tags (guilty-pleasure,
// comfort-watch, fantasy-aversion, …) stay: they describe the shows.
const TASTE_LABEL_TAGS = new Set(["loved", "liked", "dropped", "interested"]);

function tasteTokens(c: TasteCandidate): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (text: string | undefined, weight: number) => {
    if (!text) return;
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 3 || TASTE_STOP.has(tok) || TASTE_LABEL_TAGS.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + weight);
    }
  };
  for (const t of c.tags ?? []) add(t.replace(/-/g, " "), 3);
  add(c.title, 1);
  add(c.notes, 1);
  return counts;
}

/** Rules-only taste scorer: tag/keyword overlap against the loved profile,
 *  penalized by overlap with the disliked profile. Deterministic, no network.
 *  `excludeId` enables leave-one-out scoring for the eval harness. */
export function scoreTasteRules(
  profile: TasteProfile,
  candidates: TasteCandidate[],
  excludeId?: string
): TasteScore[] {
  const lovedAgg = new Map<string, number>();
  const lovedSource = new Map<string, string>();
  for (const l of profile.loved) {
    if (l.id === excludeId) continue;
    for (const [tok, w] of tasteTokens(l)) {
      lovedAgg.set(tok, (lovedAgg.get(tok) ?? 0) + w);
      if (!lovedSource.has(tok)) lovedSource.set(tok, l.title);
    }
  }
  const dislikedAgg = new Map<string, number>();
  const dislikedSource = new Map<string, string>();
  for (const d of profile.disliked) {
    for (const [tok, w] of tasteTokens(d)) {
      dislikedAgg.set(tok, (dislikedAgg.get(tok) ?? 0) + w);
      if (!dislikedSource.has(tok)) dislikedSource.set(tok, d.title);
    }
  }
  const excluded = new Set(profile.excludedIds);
  return candidates.map((c) => {
    if (excluded.has(c.id)) {
      return { id: c.id, confidence: 0.05, reason: "Excluded category — never recommended." };
    }
    const toks = tasteTokens(c);
    let raw = 0;
    const hits: { tok: string; w: number }[] = [];
    let disHit = "";
    for (const [tok, w] of toks) {
      const lw = lovedAgg.get(tok) ?? 0;
      if (lw > 0) {
        raw += lw * w;
        hits.push({ tok, w: lw * w });
      }
      const dw = dislikedAgg.get(tok) ?? 0;
      if (dw > 0) {
        raw -= 1.5 * dw * w;
        if (!disHit && dislikedSource.get(tok)) disHit = dislikedSource.get(tok)!;
      }
    }
    hits.sort((a, b) => b.w - a.w);
    const confidence = Math.min(0.95, Math.max(0.05, 1 / (1 + Math.exp(-raw / 8))));
    let reason: string;
    if (hits.length > 0) {
      const t1 = hits[0].tok;
      const src = lovedSource.get(t1) ?? "your loved shows";
      reason = `Shares ${t1}${hits[1] ? `, ${hits[1].tok}` : ""} with ${src}.`;
    } else if (disHit) {
      reason = `Little overlap with your loved shows; echoes ${disHit}.`;
    } else {
      reason = "Little overlap with your loved shows.";
    }
    return { id: c.id, confidence: Math.round(confidence * 100) / 100, reason: reason.slice(0, 140) };
  });
}

export interface GoldTasteRow {
  item_id: string;
  title: string;
  tags?: string[];
  notes?: string;
  watch?: string;
  status?: string;
  category?: string;
  recommendable?: boolean;
}

/** Gold rows → profile. Loved = watch:yes; disliked = watch:no;
 *  recommendable:false ids are excluded from output, never from signal. */
export function buildTasteProfile(rows: GoldTasteRow[]): TasteProfile {
  return {
    loved: rows
      .filter((r) => r.watch === "yes")
      .map((r) => ({ id: r.item_id, title: r.title, tags: r.tags, notes: r.notes })),
    disliked: rows
      .filter((r) => r.watch === "no")
      .map((r) => ({ id: r.item_id, title: r.title, tags: r.tags, notes: r.notes })),
    excludedIds: rows.filter((r) => r.recommendable === false).map((r) => r.item_id),
  };
}

export function buildTastePrompt(
  profile: TasteProfile,
  candidates: TasteCandidate[]
): { system: string; user: string; maxTokens?: number } {
  const fmt = (c: TasteCandidate) => `- ${c.id}: ${c.title}${c.tags?.length ? ` [${c.tags.join(", ")}]` : ""}${c.notes ? ` — ${c.notes}` : ""}`;
  return {
    system:
      "You are a TV recommender for one specific person. Score ONLY the listed candidates 0-1 by how much they would enjoy them. Respect hard exclusions absolutely. Reasons are one line, max 25 words, plain sentence case, no emphasis typography. Reply with JSON only: {\"picks\": [{\"id\": ..., \"confidence\": ..., \"reason\": ...}]}.",
    user: [
      "Shows they loved:",
      ...profile.loved.map(fmt),
      "",
      "Shows they dropped (do NOT recommend things like these):",
      ...profile.disliked.map(fmt),
      "",
      `Hard exclusions (confidence must stay near 0): ${profile.excludedIds.join(", ") || "none"}`,
      "",
      "Candidates to score:",
      ...candidates.map(fmt),
    ].join("\n"),
    // 38 candidates × ~60 tokens per pick — 800 truncates the array into
    // invalid JSON (observed live). Size for the candidate count instead.
    maxTokens: 150 * candidates.length + 200,
  };
}

export interface TasteResult {
  scores: TasteScore[];
  generatedBy: "llm" | "rules";
  providerId?: string;
  model?: string;
  cacheHit: boolean;
  reason?: string;
}

export async function runTasteStage(deps: {
  db: Db;
  runId: number;
  profile: TasteProfile;
  candidates: TasteCandidate[];
  mode: LlmMode;
  cacheTtlDays: number;
  refs: ProviderRef[];
  log?: (msg: string) => void;
}): Promise<TasteResult> {
  const rules = scoreTasteRules(deps.profile, deps.candidates);
  const rulesById = new Map(rules.map((s) => [s.id, s]));
  const r = await runJsonStage<z.infer<typeof TasteOutputSchema>>({
    ...deps,
    stage: "taste",
    version: "taste/v1",
    cachePayload: { profile: deps.profile, candidates: deps.candidates },
    buildPrompt: () => buildTastePrompt(deps.profile, deps.candidates),
    schema: TasteOutputSchema,
  });
  if (r.output) {
    const seen = new Set<string>();
    const scores: TasteScore[] = [];
    for (const p of r.output.picks) {
      if (seen.has(p.id) || !rulesById.has(p.id)) continue; // ignore unknown ids
      seen.add(p.id);
      scores.push({ id: p.id, confidence: p.confidence, reason: p.reason });
    }
    // Any candidate the model omitted keeps its rules score, marked as such.
    for (const s of rules) {
      if (!seen.has(s.id)) scores.push({ ...s, reason: `${s.reason} (rules fallback)` });
    }
    return {
      scores,
      generatedBy: "llm",
      providerId: r.providerId,
      model: r.model,
      cacheHit: r.cacheHit,
    };
  }
  return { scores: rules, generatedBy: "rules", reason: r.reason, cacheHit: false };
}
