import {
  finishRun,
  insertRun,
  lastSuccessfulRun,
  loadConfig,
  openDb,
  recordLlmCall,
  type CanonicalItem,
  type Db,
  type LaneId,
  type LoadedConfig,
  type RawItem,
  type Trigger,
} from "@detox/core";
import { createAdapters } from "@detox/adapters";
import { templateDigest } from "@detox/llm";
import { buildStubSnapshot, writeSnapshot } from "./fake.js";
import { ageString, normalizeAll } from "./normalize.js";
import { dedupe, scoreItems, selectTop } from "./select.js";
import {
  buildParts,
  envcanContext,
  envcanDaily,
  envcanHourly,
  expandParts,
  median,
  metnoDaily,
  metnoHourly,
  openmeteoDaily,
  openmeteoHourly,
  spreadNote,
  torontoParts,
  type HourlyPoint,
  type PartCell,
  type WeekRow,
} from "./weather.js";

export function lastOkTimestamp(root = defaultRoot()): string | null {
  const db = openDb(root + "/data");
  try {
    const row = lastSuccessfulRun(db);
    return row ? (row.finished_at ?? row.started_at) : null;
  } finally {
    db.close();
  }
}

export interface RunResult {
  runId: number;
  status: "ok" | "error";
  snapshotPath?: string;
  error?: string;
}

export function defaultRoot(): string {
  if (process.env.DETOX_ROOT) return process.env.DETOX_ROOT;
  const cwd = process.cwd();
  const idx = cwd.toLowerCase().lastIndexOf("\\apps\\");
  if (idx > 0) return cwd.slice(0, idx);
  const fwd = cwd.lastIndexOf("/apps/");
  if (fwd > 0) return cwd.slice(0, fwd);
  return cwd;
}

interface LaneError {
  key: string;
  message: string;
}

/**
 * runPipeline — one entry point, three triggers (§4).
 * Phase 1: real adapters for weather/tech/reddit; stub snapshot fills every
 * lane without an adapter yet. Stages: collect → normalize → dedupe
 * (identity/lexical) → select (rules) → summarize (rules) → assemble.
 */
export async function runPipeline(trigger: Trigger, root = defaultRoot()): Promise<RunResult> {
  const config = loadConfig(root);
  const dataDir = root + "/data";
  const db = openDb(dataDir);
  const startedAt = new Date().toISOString();
  const nowMs = Date.now();
  const runId = insertRun(db, trigger, startedAt);
  const errors: LaneError[] = [];

  try {
    const hours = config.settings.windows.news_lookback_hours;
    const ctx = {
      fromIso: new Date(nowMs - hours * 3600_000).toISOString(),
      toIso: new Date(nowMs).toISOString(),
      settings: config.settings,
      log: (msg: string) => console.log(`[run ${runId}] ${msg}`),
    };

    // 1. collect — adapters run concurrently; per-adapter errors are captured,
    //    never thrown (a dead source degrades its lane, not the run).
    const adapters = createAdapters(config, dataDir);
    const settled = await Promise.all(
      adapters.map(async (a) => {
        try {
          return { id: a.id, items: await a.collect(ctx) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log(`${a.id} FAILED: ${message}`);
          return { id: a.id, items: [] as RawItem[], error: message };
        }
      })
    );
    const rawByAdapter = new Map(settled.map((s) => [s.id, s.items]));
    for (const s of settled) {
      if (s.error) {
        const at = new Date(nowMs).toLocaleTimeString("en-CA", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/Toronto",
        });
        for (const key of laneKeysForAdapter(s.id, config.interests.reddit.subreddits)) {
          errors.push({ key, message: `${s.id} did not respond at ${at} (${s.error}).` });
        }
      }
    }
    const rawIdByIndex = new Map<RawItem, number>();
    for (const s of settled) {
      for (const r of s.items) {
        const res = db
          .prepare("INSERT INTO raw_items (adapter, fetched_at, payload_json) VALUES (?, ?, ?)")
          .run(r.adapter, r.fetchedAt, JSON.stringify(r.payload));
        rawIdByIndex.set(r, Number(res.lastInsertRowid));
      }
    }

    // 2. normalize (+ weather lane handler → weather_forecasts/consensus)
    const allRaw = settled.flatMap((s) => s.items);
    const items = normalizeAll(allRaw, startedAt);
    for (const it of items) {
      db.prepare(
        `INSERT OR IGNORE INTO items (id, lane, source_id, url, canonical_url, title, dek, content,
          published_at, fetched_at, outlet, tier, engagement_json, location, tickers_json, raw_ref)
         VALUES (@id, @lane, @source_id, @url, @canonical_url, @title, @dek, @content,
          @published_at, @fetched_at, @outlet, @tier, @engagement_json, @location, @tickers_json, @raw_ref)`
      ).run({
        id: it.id,
        lane: it.lane,
        source_id: it.sourceId,
        url: it.url,
        canonical_url: it.canonicalUrl,
        title: it.title,
        dek: it.dek ?? null,
        content: it.content ?? null,
        published_at: it.publishedAt,
        fetched_at: it.fetchedAt,
        outlet: it.outlet ?? null,
        tier: it.tier,
        engagement_json: it.engagement ? JSON.stringify(it.engagement) : null,
        location: it.location ?? null,
        tickers_json: it.tickers ? JSON.stringify(it.tickers) : null,
        raw_ref: it.rawRef,
      });
    }

    const weatherBlock = buildWeatherBlock(db, runId, rawByAdapter, config, nowMs);

    // 3. dedupe (identity/lexical; LLM tie-break deferred)
    const newsItems = items.filter((it) => it.lane === "tech" || it.lane.startsWith("reddit-"));
    const { items: deduped, clusterSize } = dedupe(newsItems);

    // 4. select (rules only) — per lane, budget [min,max], cuts kept w/ reasons
    const [budgetMin, budgetMax] = config.interests.lane_budget as [number, number];
    void budgetMin;
    const byLane = new Map<string, CanonicalItem[]>();
    for (const it of deduped) {
      if (!byLane.has(it.lane)) byLane.set(it.lane, []);
      byLane.get(it.lane)!.push(it);
    }
    const pickedByLane = new Map<string, CanonicalItem[]>();
    const collectedByLane = new Map<string, number>();
    for (const [lane, laneItems] of byLane) {
      collectedByLane.set(lane, laneItems.length);
      const scored = scoreItems({
        lane: lane as LaneId,
        items: laneItems,
        clusterSize,
        topics: Object.fromEntries(
          Object.entries(config.interests.topics).map(([k, t]) => [
            k,
            { keywords: t.keywords, entities: t.entities, weight: t.weight },
          ])
        ),
        negatives: config.interests.negative,
        budget: [budgetMin, budgetMax],
        nowMs,
      });
      const picks = selectTop(scored, [budgetMin, budgetMax]);
      const picked: CanonicalItem[] = [];
      const insertSel = db.prepare(
        `INSERT INTO selections (run_id, lane, item_id, picked, rule_score, llm_score, rationale, summary, reason)
         VALUES (@run_id, @lane, @item_id, @picked, @rule_score, @llm_score, @rationale, @summary, @reason)`
      );
      for (const s of scored) {
        const sel = picks.get(s.item.id)!;
        insertSel.run({
          run_id: runId,
          lane,
          item_id: s.item.id,
          picked: sel.picked ? 1 : 0,
          rule_score: sel.ruleScore,
          llm_score: null,
          rationale: null,
          summary: null,
          reason: sel.reason,
        });
        if (sel.picked) picked.push(s.item);
      }
      pickedByLane.set(lane, picked);
    }

    // 5. summarize (rules only) + templated digest from real top items
    const techTop = pickedByLane.get("tech")?.[0];
    const toronto = weatherBlock.locations.find((l) => l.id === weatherBlock.defaultLocation);
    const afternoon = toronto?.parts.find((p) => p.name.toLowerCase() === "afternoon");
    const digestText = templateDigest({
      weather:
        afternoon?.consensus != null
          ? `${toronto!.name} reaches around ${afternoon.consensus}° this afternoon.`
          : undefined,
      urgent: techTop ? `Top story: ${techTop.title}.` : undefined,
    });

    // 6. assemble — stub base for lanes without adapters yet, real data over it
    const snapshot = buildStubSnapshot(runId);
    const lanes = snapshot.lanes as Record<string, unknown>;
    const laneCounts = snapshot.laneCounts as Record<string, { shown: number; collected: number }>;

    lanes["weather"] = {
      title: "Weather",
      defaultLocation: weatherBlock.defaultLocation,
      locations: weatherBlock.locations,
    };
    laneCounts["weather"] = { shown: weatherBlock.locations.length, collected: weatherBlock.fetched };

    if (pickedByLane.has("tech")) {
      const picked = pickedByLane.get("tech")!;
      lanes["tech"] = {
        title: "Tech",
        items: picked.map((it) => ({
          id: it.id,
          title: it.title,
          summary: it.dek ?? null,
          meta: { outlet: it.outlet ?? "", age: ageString(it.publishedAt, nowMs) },
          url: it.url,
        })),
      };
      laneCounts["tech"] = { shown: picked.length, collected: collectedByLane.get("tech") ?? picked.length };
    }

    for (const [lane, picked] of pickedByLane) {
      if (!lane.startsWith("reddit-")) continue;
      const withComments = picked.map((it) => {
        const raw = allRaw.find(
          (r) =>
            r.adapter === "reddit.listings" &&
            `rd:${String((r.payload as { post?: { id?: unknown } }).post?.id ?? "")}` === it.id
        );
        const comments = (
          ((raw?.payload as { comments?: { author?: unknown; score?: unknown; body?: unknown }[] })
            ?.comments ?? []) as { author?: unknown; score?: unknown; body?: unknown }[]
        ).map((c) => ({
          author: String(c.author ?? ""),
          score: typeof c.score === "number" ? c.score : null,
          body: String(c.body ?? ""),
        }));
        return {
          id: it.id,
          title: it.title,
          summary: null,
          content: it.content ?? "",
          comments,
          meta: {
            outlet: it.outlet ?? "",
            age: ageString(it.publishedAt, nowMs),
            score: it.engagement?.score ?? 0,
            comments: it.engagement?.comments ?? 0,
          },
          url: it.url,
        };
      });
      const title = lane === "reddit-nba" ? "r/nba" : lane === "reddit-uwaterloo" ? "r/uwaterloo" : lane;
      lanes[lane] = { title, items: withComments };
      laneCounts[lane] = { shown: picked.length, collected: collectedByLane.get(lane) ?? picked.length };
    }

    snapshot.digest = { text: digestText, generatedBy: "template" };
    snapshot.cost = { usdToday: 0, capUsd: config.models.budget.daily_cap_usd, degraded: false };
    (snapshot as unknown as { laneStatus: Record<string, { ok: boolean; note: string | null }> }).laneStatus =
      Object.fromEntries(
        [...new Set([...laneStatusKeys(), ...errors.map((e) => e.key)])].map((key) => {
          const err = errors.find((e) => e.key === key);
          return [key, err ? { ok: false, note: err.message } : { ok: true, note: null }];
        })
      );

    recordLlmCall(db, {
      run_id: runId,
      stage: "digests",
      model: config.models.models.bulk,
      provider: config.models.router.provider,
      est_cost_usd: 0,
    });

    const snapshotPath = writeSnapshot(root + "/data", snapshot);
    db.prepare("INSERT INTO settings_snapshot (run_id, payload_json) VALUES (?, ?)").run(
      runId,
      JSON.stringify({ interests: "loaded", settings: "loaded", at: startedAt })
    );
    finishRun(db, runId, "ok", new Date().toISOString());
    db.close();
    const collected = allRaw.length;
    console.log(`[run ${runId}] ok — ${collected} raw items → ${snapshotPath}`);
    return { runId, status: "ok", snapshotPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      finishRun(db, runId, "error", new Date().toISOString(), message);
    } finally {
      db.close();
    }
    return { runId, status: "error", error: message };
  }
}

function laneKeysForAdapter(adapterId: string, subs: string[]): string[] {
  if (adapterId === "weather.envcan") return ["weather.envcan"];
  if (adapterId === "weather.openmeteo") return ["weather.openmeteo"];
  if (adapterId === "weather.metno") return ["weather.metno"];
  if (adapterId === "news.newsflash") return ["tech"];
  if (adapterId === "reddit.listings") return subs.map((s) => `reddit-${s}`);
  return [adapterId];
}

function laneStatusKeys(): string[] {
  return ["weather.envcan", "weather.openmeteo", "weather.metno", "tech"];
}

interface WeatherLocationBlock {
  id: string;
  name: string;
  context: string;
  parts: PartCell[];
  spread?: string;
  week: import("./weather.js").WeekRow[];
}

function buildWeatherBlock(
  db: Db,
  runId: number,
  rawByAdapter: Map<string, RawItem[]>,
  config: LoadedConfig,
  nowMs: number
): { locations: WeatherLocationBlock[]; defaultLocation: string; fetched: number } {
  const locations = config.interests.weather.locations;
  const parts = expandParts(
    config.interests.weather.day_parts as Record<string, [number, number]>
  );
  const today = torontoParts(new Date(nowMs).toISOString()).date;

  const byLocSrc = new Map<string, Map<string, unknown>>();
  for (const [adapterId, raws] of rawByAdapter) {
    const src =
      adapterId === "weather.envcan" ? "envcan"
      : adapterId === "weather.openmeteo" ? "openmeteo"
      : adapterId === "weather.metno" ? "metno"
      : null;
    if (!src) continue;
    for (const r of raws) {
      const loc = (r.payload as { location?: { id?: string } }).location;
      if (!loc?.id) continue;
      if (!byLocSrc.has(loc.id)) byLocSrc.set(loc.id, new Map());
      byLocSrc.get(loc.id)!.set(src, (r.payload as { data?: unknown }).data);
      db.prepare(
        "INSERT INTO weather_forecasts (run_id, source, location, issued_at, payload_json) VALUES (?, ?, ?, ?, ?)"
      ).run(runId, src, loc.id, r.fetchedAt, JSON.stringify(r.payload));
    }
  }

  const blocks: WeatherLocationBlock[] = [];
  let fetched = 0;
  for (const loc of locations) {
    const srcs = byLocSrc.get(loc.id) ?? new Map<string, unknown>();
    fetched += srcs.size;

    const pointsBySource: Record<string, HourlyPoint[]> = {};
    // EC payloads are GeoJSON Features — extractors take .properties.
    const envcanProps = (srcs.get("envcan") as { properties?: unknown } | undefined)?.properties;
    if (envcanProps) pointsBySource["envcan"] = envcanHourly(envcanProps as never);
    if (srcs.has("openmeteo")) pointsBySource["openmeteo"] = openmeteoHourly(srcs.get("openmeteo") as never);
    if (srcs.has("metno")) pointsBySource["metno"] = metnoHourly(srcs.get("metno") as never);
    const cells = buildParts(pointsBySource, parts, today);

    // Night spread note (the "sources disagree tonight" line).
    const night = cells.find((c) => c.name.toLowerCase() === "night");
    const nightVals = night ? Object.values(night.sources) : [];
    const spread = spreadNote(nightVals, 3);
    const spreadText = spread ? `Sources disagree tonight: ${spread}.` : "";

    // 7-day rows: highs/lows per source, median consensus.
    const dates = new Set<string>();
    const perSource: Record<string, Map<string, [number | null, number | null]>> = {};
    if (srcs.has("openmeteo")) {
      perSource["openmeteo"] = new Map(
        openmeteoDaily(srcs.get("openmeteo") as never).map((d) => [d.date, [d.max, d.min]])
      );
      for (const d of perSource["openmeteo"].keys()) dates.add(d);
    }
    if (srcs.has("metno")) {
      const pts: HourlyPoint[] = [];
      if (pointsBySource["metno"]) pts.push(...pointsBySource["metno"]);
      perSource["metno"] = new Map(metnoDaily(pts).map((d) => [d.date, [d.max, d.min]]));
      for (const d of perSource["metno"].keys()) dates.add(d);
    }
    // EC periods carry weekday names, not dates: align by order against the
    // Open-Meteo calendar (both cover the same coming week).
    const orderedDates = [...dates].sort();
    if (envcanProps) {
      const ec = envcanDaily(envcanProps as never);
      perSource["envcan"] = new Map(ec.map((p, i) => [orderedDates[i] ?? `day-${i}`, [p.high, p.low]]));
      for (const d of perSource["envcan"].keys()) dates.add(d);
    }

    const week: WeekRow[] = [...dates].sort().slice(0, 7).map((date) => {
      const sources: Record<string, [number | null, number | null]> = {};
      for (const [src, m] of Object.entries(perSource)) {
        sources[src] = m.get(date) ?? [null, null];
      }
      const hi = median(Object.values(sources).map(([h]) => h));
      const lo = median(Object.values(sources).map(([, l]) => l));
      const row: WeekRow = { day: "", date, consensus: [hi, lo], sources };
      const sp = spreadNote(
        Object.values(sources).map(([h]) => h),
        3
      );
      if (sp) row.spread = sp;
      return row;
    });
    // Human day names for the ordered dates.
    week.forEach((row) => {
      const d = new Date(row.date + "T12:00:00");
      row.day = d.toLocaleDateString("en-CA", { weekday: "long", timeZone: "America/Toronto" });
    });

    const context = envcanProps ? envcanContext(envcanProps as never) : "";
    const consensusPayload = { parts: cells, week: week.map((w) => ({ date: w.date, consensus: w.consensus })) };
    db.prepare("INSERT INTO weather_consensus (run_id, location, payload_json) VALUES (?, ?, ?)").run(
      runId,
      loc.id,
      JSON.stringify(consensusPayload)
    );
    blocks.push({ id: loc.id, name: loc.name, context, parts: cells, spread: spreadText || undefined, week });
  }
  return { locations: blocks, defaultLocation: config.interests.weather.default_location, fetched };
}
