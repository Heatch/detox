// pnpm eval [--live] — the Phase 2 measurement tool (plan §8).
// Default is rules-only: free, deterministic, consumes no Gemini RPD and no
// Luna dollars. --live additionally runs the taste LLM stage over the same
// candidates so prompts are compared with data instead of vibes. Live eval
// calls count against the same pools as production (same DB, run trigger
// "eval"); a starved Gemini falls through to Luna, which spends real cents.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTasteProfile,
  buildBudget,
  buildProviders,
  providerRef,
  resolveStageTarget,
  runTasteStage,
  scoreTasteRules,
  type GoldTasteRow,
  type TasteCandidate,
} from "@detox/llm";
import {
  finishRun,
  insertRun,
  loadConfig,
  openDb,
  type Db,
} from "@detox/core";
import { defaultRoot } from "./run.js";

interface Ranked {
  id: string;
  title: string;
  watch: string;
  confidence: number;
  reason: string;
  goldConfidence?: number;
}

function loadGold(root: string): GoldTasteRow[] {
  const raw = readFileSync(join(root, "evals", "gold.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GoldTasteRow);
}

function rank(
  rows: GoldTasteRow[],
  scores: Map<string, { confidence: number; reason: string }>,
  goldConf: Map<string, number>
): Ranked[] {
  return rows
    .map((r) => ({
      id: r.item_id,
      title: r.title,
      watch: r.watch ?? "?",
      confidence: scores.get(r.item_id)?.confidence ?? 0,
      reason: scores.get(r.item_id)?.reason ?? "unscored",
      goldConfidence: goldConf.get(r.item_id),
    }))
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));
}

function report(name: string, ranked: Ranked[]): void {
  const top5 = ranked.slice(0, 5);
  const p5 = top5.filter((r) => r.watch === "yes").length / 5;
  const noInTop10 = ranked.slice(0, 10).filter((r) => r.watch === "no").length;
  const interested = ranked.filter((r) => r.title && interestedIds.has(r.id));
  const meanRankInterested =
    interested.length > 0
      ? interested.reduce((a, r) => a + ranked.indexOf(r) + 1, 0) / interested.length
      : NaN;
  console.log(`\n== ${name} ==`);
  console.log(`candidates: ${ranked.length} | precision@5: ${p5.toFixed(2)} | watch=no in top10: ${noInTop10} | mean rank of interested-5: ${Number.isNaN(meanRankInterested) ? "n/a" : meanRankInterested.toFixed(1)}`);
  for (const [i, r] of ranked.entries()) {
    const flag = r.watch === "no" && i < 10 ? "  <-- REJECT-SHOULD-WIN" : "";
    console.log(
      `  ${(i + 1).toString().padStart(2)}. [${r.watch.padEnd(5)} ${r.confidence.toFixed(2)}] ${r.title}${flag}`
    );
  }
}

const interestedIds = new Set<string>();

async function main(): Promise<void> {
  const live = process.argv.slice(2).includes("--live");
  const root = process.env.DETOX_ROOT ?? defaultRoot();
  const config = loadConfig(root);
  const rows = loadGold(root);
  console.log(`gold set: ${rows.length} rows`);

  const profile = buildTasteProfile(rows);
  const recommendable = rows.filter((r) => r.recommendable !== false);
  const completed = recommendable.filter((r) => r.status === "completed");
  const others = recommendable.filter((r) => r.status !== "completed");
  for (const r of rows.filter((r) => r.status === "interested")) interestedIds.add(r.item_id);
  console.log(
    `profile: ${profile.loved.length} loved / ${profile.disliked.length} disliked / ${profile.excludedIds.length} excluded; candidates: ${completed.length} completed (leave-one-out) + ${others.length} interested/dropped`
  );

  const toCandidate = (r: GoldTasteRow): TasteCandidate => ({
    id: r.item_id,
    title: r.title,
    tags: r.tags,
    notes: r.notes,
  });
  const goldConf = new Map(rows.map((r) => [r.item_id, typeof r === "object" && "confidence" in r ? Number((r as { confidence: number }).confidence) : NaN]));

  // Rules baseline: completed rows scored leave-one-out, others vs full profile.
  const rulesScores = new Map<string, { confidence: number; reason: string }>();
  for (const r of completed) {
    const [s] = scoreTasteRules(profile, [toCandidate(r)], r.item_id);
    rulesScores.set(r.item_id, s);
  }
  for (const s of scoreTasteRules(profile, others.map(toCandidate))) rulesScores.set(s.id, s);
  const rulesRanked = rank(recommendable, rulesScores, goldConf);
  report("rules-only taste", rulesRanked);

  if (live) {
    const db: Db = openDb(root + "/data");
    const runId = insertRun(db, "eval", new Date().toISOString());
    try {
      const dayPrefix = new Date().toISOString().slice(0, 10);
      const budget = buildBudget(db, dayPrefix, config.models);
      const providers = buildProviders(config.env, config.models);
      const target = resolveStageTarget(config.models, "taste");
      const fallbackId = target.providerId === "google-ai-studio" ? "backboard" : "google-ai-studio";
      const fallbackModel =
        fallbackId === "google-ai-studio" ? config.models.models.bulk : config.models.models.interactive;
      const refs = [target.providerId, fallbackId]
        .map((pid) =>
          providerRef(providers, budget, pid, pid === target.providerId ? target.model : fallbackModel)
        )
        .filter((r) => r !== undefined);
      const candidates = recommendable.map(toCandidate);
      const taste = await runTasteStage({
        db,
        runId,
        profile,
        candidates,
        mode: config.models.stages.taste.mode,
        cacheTtlDays: config.models.budget.cache?.ttl_days ?? 30,
        refs,
        log: (m) => console.log(`[eval] ${m}`),
      });
      console.log(`\nlive taste: generatedBy=${taste.generatedBy}${taste.providerId ? ` via ${taste.providerId}/${taste.model}` : ""}${taste.reason ? ` (${taste.reason})` : ""}`);
      const liveScores = new Map(taste.scores.map((s) => [s.id, s]));
      const liveRanked = rank(recommendable, liveScores, goldConf);
      report(`live taste (${taste.generatedBy})`, liveRanked);
      // Calibration: mean abs error vs your gold confidences (completed rows).
      let err = 0;
      let n = 0;
      for (const r of liveRanked) {
        if (r.goldConfidence !== undefined && !Number.isNaN(r.goldConfidence)) {
          err += Math.abs(r.confidence - r.goldConfidence);
          n++;
        }
      }
      if (n > 0) console.log(`confidence MAE vs gold: ${(err / n).toFixed(3)} over ${n} rows`);
      finishRun(db, runId, "ok", new Date().toISOString());
    } catch (err) {
      finishRun(db, runId, "error", new Date().toISOString(), err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      db.close();
    }
  } else {
    console.log("\n(rules only — re-run with --live to score the LLM taste stage too)");
  }

  // Digest eval: no digest rows exist yet — report the gap, don't fail.
  const digestRows = rows.filter((r) => (r as { kind?: string }).kind === "digest");
  if (digestRows.length === 0) {
    console.log("\ndigest: skipped — no kind:digest rows in the gold set (draft candidates for review separately)");
  } else {
    console.log(`\ndigest: ${digestRows.length} rows (scoring harness: manual 1–5 review)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
