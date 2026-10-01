import { unwrapEn as en } from "@detox/adapters";

// Weather lane math (experiment 006): day-part means over Toronto-local
// hours, median consensus per cell, spread notes past thresholds, EC
// textSummary as the free context line. Pure arithmetic — no LLM.

export interface DayPartDef {
  name: string;
  hours: number[];
  /** True when the range wraps past midnight (e.g. night 22→6). */
  wrap: boolean;
  from: number;
}

export function expandParts(dayParts: Record<string, [number, number]>): DayPartDef[] {
  return Object.entries(dayParts).map(([name, [from, to]]) => {
    const hours: number[] = [];
    let h = from;
    while (h !== to) {
      hours.push(h);
      h = (h + 1) % 24;
    }
    return { name, hours, wrap: to < from, from };
  });
}

export function torontoParts(isoUtc: string): { date: string; hour: number } {
  const d = new Date(isoUtc);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
  };
}

export function median(xs: (number | null | undefined)[]): number | null {
  const s = xs.filter((x): x is number => typeof x === "number");
  if (s.length === 0) return null;
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function mean(xs: (number | null | undefined)[]): number | null {
  const s = xs.filter((x): x is number => typeof x === "number");
  if (s.length === 0) return null;
  return Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10;
}

// --- per-source extraction (payload shapes from experiment 006) ---

export interface HourlyPoint {
  date: string;
  hour: number;
  temp: number | null;
}

export function openmeteoHourly(data: {
  hourly?: { time?: string[]; temperature_2m?: (number | null)[] };
}): HourlyPoint[] {
  const times = data.hourly?.time ?? [];
  const temps = data.hourly?.temperature_2m ?? [];
  // Open-Meteo returns Toronto-local naive times (timezone=America/Toronto).
  return times.map((t, i) => ({
    date: t.slice(0, 10),
    hour: Number(t.slice(11, 13)),
    temp: temps[i] ?? null,
  }));
}

export function metnoHourly(data: {
  properties?: { timeseries?: { time?: string; data?: { instant?: { details?: { air_temperature?: number } } } }[] };
}): HourlyPoint[] {
  return (data.properties?.timeseries ?? []).map((e) => {
    const tp = torontoParts(e.time ?? "");
    return { date: tp.date, hour: tp.hour, temp: e.data?.instant?.details?.air_temperature ?? null };
  });
}

export function envcanHourly(data: {
  hourlyForecastGroup?: { hourlyForecasts?: { timestamp?: unknown; temperature?: { value?: unknown } }[] };
}): HourlyPoint[] {
  return (data.hourlyForecastGroup?.hourlyForecasts ?? []).map((h) => {
    const ts = typeof h.timestamp === "string" ? h.timestamp : en(h.timestamp as { en: string });
    const tp = torontoParts(ts);
    const v = en(h.temperature?.value as { en: number } | number);
    return { date: tp.date, hour: tp.hour, temp: typeof v === "number" ? v : null };
  });
}

export function openmeteoDaily(data: {
  daily?: { time?: string[]; temperature_2m_max?: (number | null)[]; temperature_2m_min?: (number | null)[] };
}): { date: string; max: number | null; min: number | null }[] {
  const d = data.daily ?? {};
  return (d.time ?? []).map((t, i) => ({
    date: t,
    max: d.temperature_2m_max?.[i] ?? null,
    min: d.temperature_2m_min?.[i] ?? null,
  }));
}

export function metnoDaily(points: HourlyPoint[]): { date: string; max: number | null; min: number | null }[] {
  const byDate = new Map<string, number[]>();
  for (const p of points) {
    if (p.temp == null) continue;
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date)!.push(p.temp);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, 7)
    .map(([date, vals]) => ({ date, max: Math.max(...vals), min: Math.min(...vals) }));
}

export interface EcPeriod {
  day: string;
  high: number | null;
  low: number | null;
}

// EC day/night periods arrive as an ordered high/low sequence, usually
// starting with tonight's low. Pair into day rows without dropping it.
export function envcanDaily(data: {
  forecastGroup?: {
    forecasts?: {
      period?: { value?: unknown };
      temperatures?: { temperature?: { class?: unknown; value?: unknown }[] };
    }[];
  };
}): EcPeriod[] {
  const rows: EcPeriod[] = [];
  let open: EcPeriod | null = null;
  for (const f of data.forecastGroup?.forecasts ?? []) {
    const t = f.temperatures?.temperature?.[0];
    if (!t) continue;
    const cls = String(en(t.class as { en: string }));
    const val = en(t.value as { en: number });
    const num = typeof val === "number" ? val : null;
    const day = String(en(f.period?.value as { en: string }));
    if (cls === "high") {
      if (open) rows.push(open);
      open = { day, high: num, low: null };
    } else if (cls === "low") {
      if (open) {
        open.low = num;
        rows.push(open);
        open = null;
      } else {
        rows.push({ day, high: null, low: num });
      }
    }
  }
  if (open) rows.push(open);
  return rows;
}

export function envcanContext(data: {
  forecastGroup?: { forecasts?: { textSummary?: unknown }[] };
}): string {
  const f0 = data.forecastGroup?.forecasts?.[0];
  const s = f0 ? en(f0.textSummary as { en: string }) : "";
  return typeof s === "string" ? s : "";
}

// --- assembly ---

export interface PartCell {
  name: string;
  consensus: number | null;
  sources: Record<string, number | null>;
}

export interface WeekRow {
  day: string;
  date: string;
  consensus: [number | null, number | null];
  sources: Record<string, [number | null, number | null]>;
  spread?: string;
}

export function buildParts(
  pointsBySource: Record<string, HourlyPoint[]>,
  parts: DayPartDef[],
  today: string
): PartCell[] {
  // Next calendar date, for wrapped parts (night hours past midnight belong
  // to "tonight", not tomorrow morning).
  const tomorrow = new Date(today + "T12:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  return parts.map((part) => {
    const sources: Record<string, number | null> = {};
    for (const [src, pts] of Object.entries(pointsBySource)) {
      sources[src] = mean(
        pts
          .filter((p) => {
            if (!part.hours.includes(p.hour)) return false;
            if (p.date === today) return !part.wrap || p.hour >= part.from;
            return part.wrap && p.date === tomorrowStr;
          })
          .map((p) => p.temp)
      );
    }
    return { name: part.name, consensus: median(Object.values(sources)), sources };
  });
}

export function spreadNote(highs: (number | null)[], tempThreshold: number): string | undefined {
  const vals = highs.filter((x): x is number => typeof x === "number");
  if (vals.length < 2) return undefined;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi - lo < tempThreshold) return undefined;
  return `${lo}° to ${hi}°`;
}
