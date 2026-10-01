import { loadConfig } from "@detox/core";
import { lastOkTimestamp, runPipeline } from "./run.js";

// One module, three triggers (§4). The 09:00 America/Toronto timer ticks
// once a minute and checks Toronto wall-clock time — no cron dependency,
// so there is nothing native or CJS-bundled to break in the standalone
// server. Missed runs are simply missed; stale-on-open catches up.
function torontoParts(now = new Date()): { ymd: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}` };
}

export function startScheduler(root: string): void {
  let running = false;
  let lastFiredDay = "";
  const tick = async () => {
    if (running) return;
    const config = loadConfig(root);
    const { ymd, hm } = torontoParts();
    if (hm !== config.settings.refresh.daily_at || ymd === lastFiredDay) return;
    try {
      const last = lastOkTimestamp(root);
      if (last && Date.now() - Date.parse(last) < config.settings.refresh.skip_if_run_within_hours * 3600_000) {
        console.log("[scheduler] skipping 09:00 run — recent success within guard");
        lastFiredDay = ymd;
        return;
      }
      running = true;
      lastFiredDay = ymd;
      await runPipeline("scheduled", root);
    } catch (err) {
      console.error("[scheduler]", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  console.log("[scheduler] 09:00 America/Toronto run armed");
}
