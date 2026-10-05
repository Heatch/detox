import type { CollectContext, RawItem } from "@detox/core";
import { fetchJson } from "../http.js";

// ESPN site API, schedule + injuries (experiment 009). No news from this
// feature — schedule + injury report only. Shape notes from live probing
// (2026-10-04; differs from the experiment text in one place):
// game data lives under competitions[0], NOT top-level: status at
// competitions[0].status.type.{name,detail}, seasonType is an OBJECT
// ({abbreviation: "pre"}), venue/competitors/broadcasts under
// competitions[0]. Only STATUS_SCHEDULED rows are kept (FINAL rows are
// last night's news, not upcoming games); preseason rows are labeled.
export const ID = "sports.espn";

export interface TeamSpec {
  id: string;
  name: string;
  sport: string;
  league: string;
  abbr: string;
}

export interface GameRow {
  date: string;
  name: string;
  detail: string;
  venue: string;
  city: string;
  preseason: boolean;
  broadcasts: string[];
}

export interface InjuryRow {
  player: string;
  status: string;
  note: string;
  returnDate: string | null;
  updatedAt: string;
}

interface EspnEvent {
  date?: string;
  name?: string;
  seasonType?: { abbreviation?: string };
  competitions?: {
    status?: { type?: { name?: string; detail?: string } };
    venue?: { fullName?: string; address?: { city?: string } };
    broadcasts?: { names?: string[]; name?: string }[];
  }[];
}

export function parseGames(events: EspnEvent[], upcomingMax: number, nowMs: number): GameRow[] {
  const out: GameRow[] = [];
  for (const e of events ?? []) {
    const comp = e.competitions?.[0];
    if (comp?.status?.type?.name !== "STATUS_SCHEDULED") continue;
    if (!e.date || Date.parse(e.date) < nowMs - 3 * 3600_000) continue;
    const broadcasts = (comp.broadcasts ?? [])
      .flatMap((b) => b.names ?? (b.name ? [b.name] : []))
      .filter(Boolean);
    out.push({
      date: e.date,
      name: e.name ?? "Scheduled game",
      detail: comp.status?.type?.detail ?? "",
      venue: comp.venue?.fullName ?? "",
      city: comp.venue?.address?.city ?? "",
      preseason: e.seasonType?.abbreviation === "pre",
      broadcasts,
    });
    if (out.length >= upcomingMax) break;
  }
  return out;
}

interface InjuryEntry {
  athlete?: { displayName?: string };
  status?: string;
  date?: string;
  shortComment?: string;
  longComment?: string;
  details?: { type?: string; location?: string; side?: string; detail?: string; returnDate?: string };
  fantasyStatus?: { abbreviation?: string };
}

interface InjuryGroup {
  displayName?: string;
  injuries?: InjuryEntry[];
}

const JUNK_COMMENT = /^(ir[\s-]*n?r?|out|dtd|o|q|p|nr|na|—|-)?$/i;

function composeNote(shortComment: string | undefined, details: InjuryEntry["details"]): string {
  const short = (shortComment ?? "").trim();
  if (short && !JUNK_COMMENT.test(short) && short.length >= 12) return short;
  const d = details ?? {};
  const bits = [d.type, d.side ?? d.location, d.detail].filter(Boolean);
  return bits.length > 0 ? bits.join(", ") : short || "No details given.";
}

/** League-padded return dates (Tempo: everything 2027-05-01) are worse than
 *  none — drop dates more than a year out. */
function saneReturnDate(raw: string | undefined, nowMs: number): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t - nowMs > 365 * 86_400_000) return null;
  return raw;
}

export function parseInjuries(
  groups: InjuryGroup[],
  teamName: string,
  nowMs: number
): { injuries: InjuryRow[]; groupFound: boolean } {
  const group =
    groups.find((g) => g.displayName === teamName) ??
    groups.find((g) => (g.displayName ?? "").includes(teamName)) ??
    groups.find((g) => teamName.includes(g.displayName ?? "nope"));
  if (!group) return { injuries: [], groupFound: false };
  const injuries = (group.injuries ?? []).map((i) => ({
    player: i.athlete?.displayName ?? "Unknown player",
    // Non-injury types (Coach's Decision, Personal) stay visible with their
    // type as the status — availability is availability (exp 009 follow-up).
    status: i.details?.type && i.details.type !== "Injury" ? `${i.status ?? ""} (${i.details.type})`.trim() : (i.status ?? ""),
    note: composeNote(i.shortComment ?? i.longComment, i.details),
    returnDate: saneReturnDate(i.details?.returnDate, nowMs),
    updatedAt: i.date ?? "",
  }));
  return { injuries, groupFound: true };
}

export async function collectEspn(
  ctx: CollectContext,
  teams: TeamSpec[],
  base: string,
  upcomingGames: number
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const nowMs = Date.now();
  const out: RawItem[] = [];
  const leaguesDone = new Set<string>();
  const injuriesByLeague = new Map<string, InjuryGroup[]>();
  for (const team of teams) {
    const sched = (await fetchJson(
      ID,
      `${base}/${team.sport}/${team.league}/teams/${team.abbr}/schedule`
    )) as { events?: EspnEvent[] };
    const games = parseGames(sched.events ?? [], upcomingGames, nowMs);
    const leagueKey = `${team.sport}/${team.league}`;
    if (!leaguesDone.has(leagueKey)) {
      leaguesDone.add(leagueKey);
      const inj = (await fetchJson(ID, `${base}/${leagueKey}/injuries`)) as {
        injuries?: InjuryGroup[];
      };
      injuriesByLeague.set(leagueKey, inj.injuries ?? []);
    }
    const { injuries, groupFound } = parseInjuries(injuriesByLeague.get(leagueKey) ?? [], team.name, nowMs);
    if (!groupFound) ctx.log(`${ID} ${team.id}: no injury group for ${team.name}`);
    ctx.log(`${ID} ${team.id}: ${games.length} games, ${injuries.length} injuries`);
    out.push({ adapter: ID, fetchedAt: at, payload: { team, games, injuries } });
  }
  return out;
}
