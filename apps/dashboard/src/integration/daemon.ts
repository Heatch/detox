import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, found by walking up to the pnpm workspace file. This module is
 *  reached from `src/integration` in dev and from `dist/server` in a build, so
 *  a fixed number of `..` hops lands in the wrong place in one of the two. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** How `@detox/pipeline` gets loaded. Those workspace packages ship raw
 *  TypeScript with `.js`-style specifiers, so plain `import()` only works under
 *  a TS-aware loader — the tsx loader in production, Vite's module runner in
 *  dev. Anything that throws must stay inside this function's try/catch. */
export interface PipelineModule {
  runPipeline: (trigger: string, root: string) => Promise<unknown>;
  startScheduler: (root: string) => void;
}
export type PipelineLoader = (specifier: string) => Promise<PipelineModule>;

const importViaNode: PipelineLoader = (s) => import(s);

/** Arms the daemon: initial pipeline run if there is no snapshot yet, then the
 *  09:00 scheduler. Never throws — a dead source or a bad config must not take
 *  the server down with it. */
export async function armDaemon(
  root: string,
  load: PipelineLoader = importViaNode
): Promise<void> {
  let pipeline: PipelineModule;
  try {
    pipeline = await load("@detox/pipeline");
  } catch (err) {
    console.error("[daemon] could not load @detox/pipeline:", message(err));
    return;
  }

  if (!existsSync(join(root, "data", "snapshots", "latest.json"))) {
    console.log("[daemon] no snapshot yet — running initial pipeline");
    try {
      await pipeline.runPipeline("manual", root);
    } catch (err) {
      console.error("[daemon] initial pipeline failed:", message(err));
    }
  }

  pipeline.startScheduler(root);
  console.log("[daemon] ready, root=" + root);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Daemon integration: dev only. Astro does not run integration hooks in a
 *  built standalone server, so `scripts/start.mjs` arms the daemon there. */
export function daemon(): AstroIntegration {
  return {
    name: "detox-daemon",
    hooks: {
      "astro:server:setup": async ({ server }) => {
        const root = process.env.DETOX_ROOT ?? findRepoRoot(here);
        process.env.DETOX_ROOT ??= root;
        // Go through Vite so the workspace TypeScript resolves in dev.
        // ssrLoadModule is untyped on purpose; assert the shape we rely on.
        await armDaemon(root, (s) => server.ssrLoadModule(s) as Promise<PipelineModule>);
      },
    },
  };
}
