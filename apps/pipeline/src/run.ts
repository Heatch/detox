import {
  finishRun,
  insertRun,
  lastSuccessfulRun,
  loadConfig,
  openDb,
  recordLlmCall,
  type Trigger,
} from "@detox/core";
import { adapters } from "@detox/adapters";
import { buildStubSnapshot, writeSnapshot } from "./fake.js";

export interface RunResult {
  runId: number;
  status: "ok" | "error";
  snapshotPath?: string;
  error?: string;
}

export function defaultRoot(): string {
  if (process.env.DETOX_ROOT) return process.env.DETOX_ROOT;
  // pnpm --filter runs scripts in the package dir: <root>/apps/pipeline.
  const cwd = process.cwd();
  const idx = cwd.toLowerCase().lastIndexOf("\\apps\\");
  if (idx > 0) return cwd.slice(0, idx);
  const fwd = cwd.lastIndexOf("/apps/");
  if (fwd > 0) return cwd.slice(0, fwd);
  return cwd;
}

/**
 * runPipeline — one entry point, three triggers (§4).
 * Phase 0: the stages are stubbed but shaped like the real thing.
 * collect (stub) → normalize → dedupe (identity) → select (rules) →
 * summarize (off; templated digest) → assemble (snapshot + cost).
 */
export async function runPipeline(trigger: Trigger, root = defaultRoot()): Promise<RunResult> {
  const config = loadConfig(root);
  const db = openDb(root + "/data");
  const startedAt = new Date().toISOString();
  const runId = insertRun(db, trigger, startedAt);

  try {
    const hours = config.settings.windows.news_lookback_hours;
    const now = Date.now();
    const ctx = {
      fromIso: new Date(now - hours * 3600_000).toISOString(),
      toIso: new Date(now).toISOString(),
      settings: config.settings,
      log: (msg: string) => console.log(`[run ${runId}] ${msg}`),
    };

    // 1. collect (stub adapters)
    const raw = (await Promise.all(adapters.map((a) => a.collect(ctx)))).flat();
    for (const r of raw) {
      db.prepare("INSERT INTO raw_items (adapter, fetched_at, payload_json) VALUES (?, ?, ?)").run(
        r.adapter,
        r.fetchedAt,
        JSON.stringify(r.payload)
      );
    }

    // 2–4. normalize → dedupe (identity) → select (rules: stub keeps all)
    const collected = raw.length;

    // 5. summarize: off in Phase 0. Digest is templated (rules-only mode).
    // One llm_calls row per run even at zero cost — the footer reads from it.
    recordLlmCall(db, {
      run_id: runId,
      stage: "digests",
      model: config.models.models.bulk,
      provider: config.models.router.provider,
      est_cost_usd: 0,
    });

    // 6. assemble
    const snapshot = buildStubSnapshot(runId);
    const snapshotPath = writeSnapshot(root + "/data", snapshot);
    db.prepare("INSERT INTO settings_snapshot (run_id, payload_json) VALUES (?, ?)").run(
      runId,
      JSON.stringify({ interests: "loaded", settings: "loaded", at: startedAt })
    );
    finishRun(db, runId, "ok", new Date().toISOString());
    db.close();
    console.log(`[run ${runId}] ok — ${collected} stub items → ${snapshotPath}`);
    return { runId, status: "ok", snapshotPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      finishRun(db, runId, "error", new Date().toISOString(), message);
    } finally {
      db.close();
    }
    return { runId, status: "error", error: message };
  }
}

export function lastOkTimestamp(root = defaultRoot()): string | null {
  const db = openDb(root + "/data");
  try {
    const row = lastSuccessfulRun(db);
    return row ? (row.finished_at ?? row.started_at) : null;
  } finally {
    db.close();
  }
}
