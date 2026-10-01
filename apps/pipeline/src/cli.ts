import { runPipeline, defaultRoot } from "./run.js";
import type { Trigger } from "@detox/core";

const trigger = (process.argv[3] ?? "manual") as Trigger;
const root = process.env.DETOX_ROOT ?? defaultRoot();

runPipeline(trigger, root).then(
  (r) => {
    if (r.status !== "ok") {
      console.error("pipeline failed:", r.error);
      process.exitCode = 1;
    }
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  }
);
