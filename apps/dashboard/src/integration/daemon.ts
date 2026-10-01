import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");

/** Daemon integration: one process serves the dashboard, runs the pipeline,
 *  and arms the 09:00 scheduler (§4). Fires on server setup (dev + standalone). */
export function daemon(): AstroIntegration {
  return {
    name: "detox-daemon",
    hooks: {
      "astro:server:setup": async () => {
        process.env.DETOX_ROOT ??= ROOT;
        const { runPipeline } = await import("@detox/pipeline");
        const { startScheduler } = await import("@detox/pipeline");
        if (!existsSync(resolve(ROOT, "data", "snapshots", "latest.json"))) {
          console.log("[daemon] no snapshot yet — running initial pipeline");
          await runPipeline("manual", ROOT);
        }
        startScheduler(ROOT);
        console.log("[daemon] ready, root=" + ROOT);
      },
    },
  };
}
