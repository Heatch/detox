import type { APIRoute } from "astro";
import { runPipeline } from "@detox/pipeline";
import { isRefreshing, setRefreshing } from "./state.js";

function root(): string {
  return process.env.DETOX_ROOT ?? process.cwd();
}

// POST /api/refresh → fire-and-forget runPipeline("manual"), 202 (§4, rule 3).
// Never blocks: the dashboard polls /api/state and updates in place.
export const POST: APIRoute = async () => {
  if (isRefreshing()) {
    return new Response(JSON.stringify({ accepted: true, alreadyRunning: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }
  setRefreshing(true);
  void runPipeline("manual", root()).finally(() => setRefreshing(false));
  return new Response(JSON.stringify({ accepted: true, alreadyRunning: false }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
};
