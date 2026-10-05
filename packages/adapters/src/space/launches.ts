import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// Launch Library 2 upcoming launches (experiment 007): exactly the
// /upcoming/ endpoint, net-ordered, one request per run. Guest throttling
// applies — a free token raises the ceiling if it ever bites.
export const ID = "space.launches";

export interface LaunchRow {
  id: string;
  name: string;
  net: string;
  vehicle: string;
  mission: string;
  pad: string;
  location: string;
  provider: string;
  status: string;
  webcast: boolean;
  probability: number | null;
  url?: string;
}

interface LlLaunch {
  id?: number | string;
  name?: string;
  net?: string;
  url?: string;
  status?: { abbrev?: string; name?: string };
  launch_service_provider?: { name?: string };
  rocket?: { configuration?: { name?: string; full_name?: string } };
  mission?: { name?: string };
  pad?: { name?: string; location?: { name?: string } };
  webcast_live?: boolean;
  probability?: number | null;
}

export function parseLaunch(l: LlLaunch): LaunchRow | null {
  if (l.id == null || !l.net) return null;
  return {
    id: `ll:${String(l.id)}`,
    name: l.name ?? "Unnamed launch",
    net: l.net,
    vehicle: l.rocket?.configuration?.full_name ?? l.rocket?.configuration?.name ?? "",
    mission: l.mission?.name ?? "",
    pad: l.pad?.name ?? "",
    location: l.pad?.location?.name ?? "",
    provider: l.launch_service_provider?.name ?? "",
    status: l.status?.abbrev ?? l.status?.name ?? "",
    webcast: l.webcast_live ?? false,
    probability: typeof l.probability === "number" ? l.probability : null,
    url: l.url,
  };
}

export async function collectLaunches(
  ctx: CollectContext,
  base: string,
  limit: number
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const params = new URLSearchParams({ limit: String(limit), ordering: "net" });
  const res = (await fetchJson(ID, `${base}/launch/upcoming/?${params}`)) as {
    results?: LlLaunch[];
  };
  const rows = (res.results ?? []).map(parseLaunch).filter((r): r is LaunchRow => r !== null);
  ctx.log(`${ID}: ${rows.length} upcoming launches`);
  return rows.map((launch) => ({ adapter: ID, fetchedAt: at, payload: { launch } }));
}
