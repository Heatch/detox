import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";
import { SnapshotSchema, loadConfig } from "@detox/core";
import { lastOkTimestamp } from "@detox/pipeline";

let refreshing = false;

export function isRefreshing(): boolean {
  return refreshing;
}

export function setRefreshing(v: boolean): void {
  refreshing = v;
}

function root(): string {
  return process.env.DETOX_ROOT ?? process.cwd();
}

export function readSnapshot(): { snapshot: unknown | null; path: string | null } {
  const path = join(root(), "data", "snapshots", "latest.json");
  if (!existsSync(path)) return { snapshot: null, path: null };
  return { snapshot: JSON.parse(readFileSync(path, "utf8")), path };
}

// GET /api/state → { snapshot, lastSuccessfulRun, refreshing, stale }.
// `stale` = older than refresh.on_open_stale_after_hours (§4, rule 1).
export const GET: APIRoute = async () => {
  const { snapshot } = readSnapshot();
  const config = loadConfig(root());
  const last = lastOkTimestamp(root());
  const staleAfterHrs = config.settings.refresh.on_open_stale_after_hours;
  const stale = !last || Date.now() - Date.parse(last) > staleAfterHrs * 3600_000;
  if (snapshot) SnapshotSchema.parse(snapshot);
  return Response.json({ snapshot, lastSuccessfulRun: last, refreshing, stale });
};
