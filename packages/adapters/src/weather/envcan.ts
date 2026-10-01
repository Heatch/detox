import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Environment Canada citypage (experiment 006): exact stations per city,
// {en, fr} nested values (unwrap `en`), hourly window runs forward from now,
// 13 day/night periods, textSummary is the free context line.
export const ID = "weather.envcan";

interface Location {
  id: string;
  name: string;
  ec_station: string;
}

// Unwrap EC's {en, fr} nesting; plain values pass through.
export function en<T>(v: { en: T; fr?: T } | T): T {
  return typeof v === "object" && v !== null && "en" in (v as object)
    ? (v as { en: T }).en
    : (v as T);
}

export async function collectEnvcan(
  ctx: CollectContext,
  locations: Location[]
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const out: RawItem[] = [];
  for (const loc of locations) {
    const url =
      `https://api.weather.gc.ca/collections/citypageweather-realtime/items/${loc.ec_station}`;
    const payload = await fetchJson(ID, url);
    out.push({ adapter: ID, fetchedAt: at, payload: { location: loc, station: loc.ec_station, data: payload } });
    ctx.log(`${ID} ${loc.id}: ok`);
  }
  return out;
}
