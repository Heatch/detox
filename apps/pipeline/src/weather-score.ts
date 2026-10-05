// pnpm weather:score — Phase 4 accuracy tracking (plan §9.2 experiment).
// Compares stored day-max forecasts (per source + consensus median) against
// Open-Meteo archive observed maxima. Read-only: touches neither the DB
// nor any quota that matters (archive API is keyless).
import { loadConfig, openDb } from "@detox/core";
import { defaultRoot } from "./run.js";
import {
  envcanDaily,
  metnoDaily,
  metnoHourly,
  openmeteoDaily,
  type HourlyPoint,
} from "./weather.js";

interface DayMax {
  runDate: string;
  target: string;
  source: string;
  location: string;
  forecast: number;
}

function dayMaxFor(source: string, payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const data = (payload as { data?: unknown }).data;
    if (source === "openmeteo") {
      for (const d of openmeteoDaily(data as never)) {
        if (d.max != null) out.set(d.date, d.max);
      }
    } else if (source === "metno") {
      const pts: HourlyPoint[] = metnoHourly(data as never);
      for (const d of metnoDaily(pts)) {
        if (d.max != null) out.set(d.date, d.max);
      }
    } else if (source === "envcan") {
      // EC periods carry weekday names, not dates — unusable for scoring
      // without the run-date alignment the pipeline applies at build time.
      // Skipped: consensus still covers EC via the median.
    }
  } catch {
    // corrupt payload — skip silently
  }
  return out;
}

async function observedMax(lat: number, lon: number, from: string, to: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: from,
    end_date: to,
    daily: "temperature_2m_max",
    timezone: "America/Toronto",
  });
  const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`);
  if (!r.ok) throw new Error(`archive HTTP ${r.status}`);
  const j = (await r.json()) as { daily?: { time?: string[]; temperature_2m_max?: (number | null)[] } };
  const out = new Map<string, number>();
  const times = j.daily?.time ?? [];
  const vals = j.daily?.temperature_2m_max ?? [];
  times.forEach((t, i) => {
    if (typeof vals[i] === "number") out.set(t, vals[i] as number);
  });
  return out;
}

async function main(): Promise<void> {
  const root = process.env.DETOX_ROOT ?? defaultRoot();
  const config = loadConfig(root);
  const db = openDb(root + "/data");
  try {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const runs = db
      .prepare("SELECT id, started_at FROM runs WHERE status = 'ok' AND started_at >= ? ORDER BY id")
      .all(since + "T00:00:00") as { id: number; started_at: string }[];
    if (runs.length === 0) {
      console.log("no successful runs in the last 14 days — nothing to score");
      return;
    }
    const forecasts: DayMax[] = [];
    const consensus: { runDate: string; target: string; location: string; hi: number }[] = [];
    for (const run of runs) {
      const runDate = run.started_at.slice(0, 10);
      const fc = db
        .prepare("SELECT source, location, payload_json FROM weather_forecasts WHERE run_id = ?")
        .all(run.id) as { source: string; location: string; payload_json: string }[];
      for (const row of fc) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        for (const [target, max] of dayMaxFor(row.source, payload)) {
          forecasts.push({ runDate, target, source: row.source, location: row.location, forecast: max });
        }
      }
      const wc = db
        .prepare("SELECT location, payload_json FROM weather_consensus WHERE run_id = ?")
        .all(run.id) as { location: string; payload_json: string }[];
      for (const row of wc) {
        try {
          const p = JSON.parse(row.payload_json) as { week?: { date?: string; consensus?: [number | null, number | null] }[] };
          for (const w of p.week ?? []) {
            if (w.date && w.consensus?.[0] != null) {
              consensus.push({ runDate, target: w.date, location: row.location, hi: w.consensus[0] as number });
            }
          }
        } catch {
          // skip
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const targets = [...new Set([...forecasts.map((f) => f.target), ...consensus.map((c) => c.target)])]
      .filter((d) => d < today)
      .sort();
    if (targets.length === 0) {
      console.log("no past target dates yet — run the pipeline, then score tomorrow");
      return;
    }
    const from = targets[0];
    const to = targets[targets.length - 1];
    const observed = new Map<string, Map<string, number>>();
    for (const loc of config.interests.weather.locations) {
      observed.set(loc.id, await observedMax(loc.lat, loc.lon, from, to));
    }

    const stats = new Map<string, { n: number; ae: number; bias: number }>();
    const add = (key: string, err: number): void => {
      const s = stats.get(key) ?? { n: 0, ae: 0, bias: 0 };
      s.n++;
      s.ae += Math.abs(err);
      s.bias += err;
      stats.set(key, s);
    };
    for (const f of forecasts) {
      const obs = observed.get(f.location)?.get(f.target);
      if (obs == null || f.target < f.runDate) continue;
      add(`${f.location} / ${f.source}`, f.forecast - obs);
    }
    for (const c of consensus) {
      const obs = observed.get(c.location)?.get(c.target);
      if (obs == null || c.target < c.runDate) continue;
      add(`${c.location} / consensus`, c.hi - obs);
    }
    if (stats.size === 0) {
      console.log("forecasts stored, but no observed data overlaps yet (ERA5 lags several days)");
      return;
    }
    console.log(`day-max error vs observed, ${from}..${to} (n = scored days):`);
    for (const [key, s] of [...stats.entries()].sort()) {
      console.log(
        `  ${key.padEnd(24)} n=${String(s.n).padStart(3)}  MAE ${(s.ae / s.n).toFixed(1)}°  bias ${s.bias / s.n >= 0 ? "+" : ""}${(s.bias / s.n).toFixed(1)}°`
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
