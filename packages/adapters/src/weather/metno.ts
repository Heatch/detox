import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// MET Norway locationforecast/2.0 (experiment 006): instant temp/wind/
// humidity, next_1_hours/next_6_hours precipitation, hourly ~59 h then
// 6-hourly ~9 days. Requires a descriptive User-Agent (see userAgentFor).
// TLS note: verified working under Node/undici on this host 2026-10-01 —
// the Python cert-store failure does not apply.
export const ID = "weather.metno";

interface Location {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export async function collectMetno(
  ctx: CollectContext,
  locations: Location[]
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const out: RawItem[] = [];
  for (const loc of locations) {
    const url =
      `https://api.met.no/weatherapi/locationforecast/2.0/compact` +
      `?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`;
    const payload = await fetchJson(ID, url);
    out.push({ adapter: ID, fetchedAt: at, payload: { location: loc, data: payload } });
    ctx.log(`${ID} ${loc.id}: ok`);
  }
  return out;
}
