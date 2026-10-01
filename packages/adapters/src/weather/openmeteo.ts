import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Open-Meteo (experiment 006): cleanest payload, 168 hourly + 7 daily per
// exact lat/lon. Includes past hours of today — the one source that fills
// morning gaps in afternoon snapshots.
export const ID = "weather.openmeteo";

interface Location {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const HOURLY = [
  "temperature_2m",
  "precipitation",
  "precipitation_probability",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
].join(",");

export async function collectOpenMeteo(
  ctx: CollectContext,
  locations: Location[]
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const out: RawItem[] = [];
  for (const loc of locations) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&hourly=${HOURLY}&daily=temperature_2m_max,temperature_2m_min` +
      `&timezone=America%2FToronto&forecast_days=7`;
    const payload = await fetchJson(ID, url);
    out.push({ adapter: ID, fetchedAt: at, payload: { location: loc, data: payload } });
    ctx.log(`${ID} ${loc.id}: ok`);
  }
  return out;
}
