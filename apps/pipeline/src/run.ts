import {
  callsToday,
  finishRun,
  insertRun,
  lastSuccessfulRun,
  loadConfig,
  openDb,
  spendTodayUsd,
  type CanonicalItem,
  type Db,
  type LaneId,
  type LoadedConfig,
  type RawItem,
  type Trigger,
} from "@detox/core";
import { createAdapters } from "@detox/adapters";
import {
  buildBudget,
  buildProviders,
  providerRef,
  resolveStageTarget,
  runDigestStage,
  runTasteStage,
  type DigestInput,
  type ProviderRef,
  type TasteCandidate,
  type TasteProfile,
  type TasteScore,
} from "@detox/llm";
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
 * Phase 2: real adapters for weather/tech/reddit; stub snapshot fills every
 * lane without an adapter yet. Stages: collect → normalize → dedupe
 * (identity/lexical) → select (rules) → digest (LLM with template fallback)
 * → assemble. The taste stage has no live candidates until the TMDB adapter
 * lands (Phase 3); it is exercised via `pnpm eval` on hand-fed gold rows.
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

    // Newsflash lane registry for this run: every configured lane except
    // spaceflight (own sources, §9.11). Drives error keys, selection, assembly.
    const nfLaneList = Object.keys(config.sources.newsflash?.lanes ?? { tech: {} }).filter(
      (l) => l !== "spaceflight"
    );
    const nfLanes = new Set(nfLaneList);
    // All lanes that select like news (Newsflash lanes + spaceflight).
    const newsLaneList = [...nfLaneList, "spaceflight"];

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
        for (const key of laneKeysForAdapter(s.id, config.interests.reddit.subreddits, nfLaneList)) {
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

    // Sports (§9.3, exp 009): per enabled team, next games + injury table.
    // Structured data, never LLM-written. One games row per team, one
    // injuries row per entry.
    interface SportsGameRow {
      date: string; name: string; detail: string; venue: string;
      city: string; preseason: boolean; broadcasts: string[];
    }
    interface SportsInjuryRow {
      player: string; status: string; note: string;
      returnDate: string | null; updatedAt: string;
    }
    const sportsTeams: { id: string; name: string; games: SportsGameRow[]; injuries: SportsInjuryRow[] }[] = [];
    const insertGame = db.prepare("INSERT INTO games (run_id, team, payload_json) VALUES (?, ?, ?)");
    const insertInjury = db.prepare(
      "INSERT INTO injuries (run_id, team, player, status, note, return_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const r of rawByAdapter.get("sports.espn") ?? []) {
      const p = r.payload as {
        team?: { id?: string; name?: string };
        games?: SportsGameRow[];
        injuries?: SportsInjuryRow[];
      };
      if (!p.team?.id) continue;
      const games = p.games ?? [];
      const injuries = p.injuries ?? [];
      insertGame.run(runId, p.team.id, JSON.stringify(games));
      for (const i of injuries) {
        insertInjury.run(runId, p.team.id, i.player, i.status, i.note, i.returnDate, i.updatedAt);
      }
      sportsTeams.push({ id: p.team.id, name: p.team.name ?? p.team.id, games, injuries });
    }

    // Launches (§9.11, exp 007): net-ordered as returned, no selection.
    const toLocal = (iso: string): string =>
      new Date(iso).toLocaleString("en-CA", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto",
      });
    const insertLaunch = db.prepare(
      "INSERT INTO launches (run_id, launch_id, net, payload_json) VALUES (?, ?, ?, ?)"
    );
    const launchItems: {
      id: string; name: string; netLocal: string; vehicle: string; mission: string;
      pad: string; location: string; provider: string; status: string;
      webcast: boolean; probability: number | null; url?: string;
    }[] = [];
    for (const r of rawByAdapter.get("space.launches") ?? []) {
      const l = (r.payload as { launch?: Record<string, unknown> }).launch;
      if (!l || typeof l.id !== "string" || typeof l.net !== "string") continue;
      insertLaunch.run(runId, l.id, l.net, JSON.stringify(l));
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      launchItems.push({
        id: l.id,
        name: str(l.name) || "Unnamed launch",
        netLocal: toLocal(l.net),
        vehicle: str(l.vehicle),
        mission: str(l.mission),
        pad: str(l.pad),
        location: str(l.location),
        provider: str(l.provider),
        status: str(l.status),
        webcast: l.webcast === true,
        probability: typeof l.probability === "number" ? l.probability : null,
        url: typeof l.url === "string" ? l.url : undefined,
      });
    }

    // 3. dedupe (identity/lexical; LLM tie-break deferred). Same-event ids
    // across lane queries collapse free = cross-lane dedupe (§7, exp 001).
    // News lanes cap at 7 days old (§9.6 open question, answered in exp 014):
    // q-lanes query the full 30-day window for ranking, so anything older
    // than a week is stale curation, not news. Reddit lanes keep their own
    // time_window and skip this cap. Spaceflight news selects like a news
    // lane (§9.11) but comes from its own API, not Newsflash.
    const MAX_NEWS_AGE_MS = 7 * 24 * 3600_000;
    const freshEnough = (it: { publishedAt: string }): boolean =>
      !(Date.parse(it.publishedAt) < nowMs - MAX_NEWS_AGE_MS);
    const newsLanes = new Set([...nfLanes, "spaceflight", "holdings"]);
    const newsItems = items.filter(
      (it) => (newsLanes.has(it.lane) && freshEnough(it)) || it.lane.startsWith("reddit-")
    );
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
      // Holdings represents a portfolio, not a feed: cap candidates per
      // ticker so one noisy mega-cap can't fill the lane (experiment 016).
      // Capped-out items keep audit rows with the cap reason.
      let selectable = scored;
      let scope: Set<(typeof scored)[number]> | null = null;
      if (lane === "holdings") {
        const perTicker = new Map<string, typeof scored>();
        for (const s of scored) {
          const t = s.item.tickers?.[0] ?? "";
          if (!perTicker.has(t)) perTicker.set(t, []);
          perTicker.get(t)!.push(s);
        }
        selectable = [...perTicker.values()].flatMap((g) => g.slice(0, 3));
        scope = new Set(selectable);
      }
      const picks = selectTop(selectable, [budgetMin, budgetMax]);
      const picked: CanonicalItem[] = [];
      const insertSel = db.prepare(
        `INSERT INTO selections (run_id, lane, item_id, picked, rule_score, llm_score, rationale, summary, reason)
         VALUES (@run_id, @lane, @item_id, @picked, @rule_score, @llm_score, @rationale, @summary, @reason)`
      );
      for (const s of scored) {
        const inScope = scope === null || scope.has(s);
        const sel = inScope ? picks.get(s.item.id)! : undefined;
        insertSel.run({
          run_id: runId,
          lane,
          item_id: s.item.id,
          picked: sel?.picked ? 1 : 0,
          rule_score: sel?.ruleScore ?? Math.round(s.score * 100) / 100,
          llm_score: null,
          rationale: null,
          summary: null,
          reason: sel ? sel.reason : "ticker cap: max 3 per ticker",
        });
        if (sel?.picked) picked.push(s.item);
      }
      pickedByLane.set(lane, picked);
    }

    // 5. digest — LLM stage (mode llm) with template fallback. Gemini first
    // (free), Luna on throttle/failure; over caps → template + footer says so.
    const dayPrefix = startedAt.slice(0, 10);
    const budget = buildBudget(db, dayPrefix, config.models);
    const providers = buildProviders(config.env, config.models);
    const cacheTtlDays = config.models.budget.cache?.ttl_days ?? 30;
    // Provider refs for a stage: configured model first, the other backend
    // as fallback (Gemini starves → Luna catches, and vice versa).
    const refsFor = (stage: "digests" | "taste"): ProviderRef[] => {
      const target = resolveStageTarget(config.models, stage);
      const fallbackId = target.providerId === "google-ai-studio" ? "backboard" : "google-ai-studio";
      const fallbackModel =
        fallbackId === "google-ai-studio" ? config.models.models.bulk : config.models.models.interactive;
      return [target.providerId, fallbackId]
        .map((pid) =>
          providerRef(providers, budget, pid, pid === target.providerId ? target.model : fallbackModel)
        )
        .filter((r) => r !== undefined);
    };
    const digestRefs = refsFor("digests");
    const techTop = pickedByLane.get("tech")?.[0];
    const toronto = weatherBlock.locations.find((l) => l.id === weatherBlock.defaultLocation);
    const afternoon = toronto?.parts.find((p) => p.name.toLowerCase() === "afternoon");
    const shownTotal = [...pickedByLane.values()].reduce((a, p) => a + p.length, 0);
    const collectedTotal = [...collectedByLane.values()].reduce((a, n) => a + n, 0);
    const digestInput: DigestInput = {
      weather:
        afternoon?.consensus != null
          ? `${toronto!.name} reaches around ${Math.round(afternoon.consensus)}° this afternoon.`
          : undefined,
      urgent: techTop ? `Top story: ${techTop.title}.` : undefined,
      counts: `Selected ${shownTotal} of ${collectedTotal} items across ${pickedByLane.size} lanes.`,
    };
    // Next game within 36 h earns a digest mention (§9.1); otherwise the
    // sports block below carries it.
    {
      let next: { team: string; dateMs: number; name: string; detail: string } | null = null;
      for (const team of sportsTeams) {
        for (const g of team.games) {
          const ms = Date.parse(g.date);
          if (ms >= nowMs && ms <= nowMs + 36 * 3600_000 && (!next || ms < next.dateMs)) {
            next = { team: team.name, dateMs: ms, name: g.name, detail: g.detail };
          }
        }
      }
      if (next) digestInput.game = `${next.team}: ${next.name} — ${next.detail}.`;
    }
    const digest = await runDigestStage({
      db,
      runId,
      input: digestInput,
      mode: config.models.stages.digests.mode,
      cacheTtlDays,
      refs: digestRefs,
      log: ctx.log,
    });
    if (digest.generatedBy === "template" && digest.reason) {
      ctx.log(`digests degraded to template: ${digest.reason}`);
    }

    // 5b. taste + releases (experiments 010, 011). Movies and new seasons
    // assemble directly; gated new-show candidates get rules + LLM
    // confidence via the taste stage (the Phase 2 promise going live).
    interface TmdbMovie { id: string; title: string; date: string; reason: string; tier: 1 | 2 }
    interface TmdbSeason { id: string; title: string; date: string; reason: string }
    interface TmdbCandidate {
      id: string; title: string; date: string; popularity: number;
      overview: string; genres: string[]; rulesConfidence: number; rulesReason: string;
    }
    const tmdbMovies: TmdbMovie[] = [];
    const tmdbSeasons: TmdbSeason[] = [];
    const tmdbCandidates: TmdbCandidate[] = [];
    let tmdbSeenGenres: { title: string; genres: string[] }[] = [];
    for (const r of rawByAdapter.get("entertainment.tmdb") ?? []) {
      const p = r.payload as {
        kind?: string;
        movie?: TmdbMovie;
        season?: TmdbSeason;
        candidate?: TmdbCandidate;
        seenGenres?: { title: string; genres: string[] }[];
      };
      if (p.kind === "movie" && p.movie) tmdbMovies.push(p.movie);
      else if (p.kind === "tv-season" && p.season) tmdbSeasons.push(p.season);
      else if (p.kind === "tv-candidate" && p.candidate) tmdbCandidates.push(p.candidate);
      else if (p.kind === "tv-profile" && p.seenGenres) tmdbSeenGenres = p.seenGenres;
    }
    const insertRelease = db.prepare(
      "INSERT INTO releases (run_id, kind, title, meta_json, date) VALUES (?, ?, ?, ?, ?)"
    );
    for (const m of tmdbMovies) {
      insertRelease.run(runId, "movie", m.title, JSON.stringify({ reason: m.reason, tier: m.tier, tmdbId: m.id }), m.date);
    }
    for (const s of tmdbSeasons) {
      insertRelease.run(runId, "tv-season", s.title, JSON.stringify({ reason: s.reason, tmdbId: s.id }), s.date);
    }
    let tvScores: TasteScore[] = [];
    let tvScoredBy: "llm" | "rules" | "none" = "none";
    if (tmdbCandidates.length > 0) {
      const profile: TasteProfile = {
        loved: tmdbSeenGenres.map((s) => ({ id: `seen:${s.title}`, title: s.title, tags: s.genres })),
        disliked: [],
        excludedIds: [],
      };
      const candidates: TasteCandidate[] = tmdbCandidates.map((c) => ({
        id: c.id, title: c.title, tags: c.genres, notes: c.overview,
      }));
      const taste = await runTasteStage({
        db,
        runId,
        profile,
        candidates,
        mode: config.models.stages.taste.mode,
        cacheTtlDays,
        refs: refsFor("taste"),
        log: ctx.log,
      });
      tvScores = taste.scores;
      tvScoredBy = taste.generatedBy;
      ctx.log(`taste: ${tvScores.length} shows scored (${tvScoredBy})`);
    }
    const tvScoreById = new Map(tvScores.map((s) => [s.id, s]));
    const tvRulesById = new Map(tmdbCandidates.map((c) => [c.id, { confidence: c.rulesConfidence, reason: c.rulesReason }]));
    for (const c of tmdbCandidates) {
      const s = tvScoreById.get(c.id);
      insertRelease.run(
        runId,
        "tv-new",
        c.title,
        JSON.stringify({
          popularity: c.popularity,
          rulesConfidence: c.rulesConfidence,
          confidence: s?.confidence ?? c.rulesConfidence,
          reason: s?.reason ?? c.rulesReason,
          scoredBy: tvScoredBy,
          tmdbId: c.id,
        }),
        c.date
      );
    }

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

    // Newsflash lanes assemble identically — headline + canonical summary +
    // outlet/age, rules-only per experiment 001 (Phase 3A).
    const NEWS_LANE_TITLES: Record<string, string> = {
      tech: "Tech",
      science: "Science",
      math: "Math",
      infrastructure: "Infrastructure",
      "canada-gta": "Canada/GTA",
      spaceflight: "Spaceflight",
    };
    // Holdings assembles custom (earnings block + ticker-tagged news), below.
    for (const lane of newsLaneList) {
      const picked = pickedByLane.get(lane);
      if (picked) {
        lanes[lane] = {
          title: NEWS_LANE_TITLES[lane] ?? lane,
          items: picked.map((it) => ({
            id: it.id,
            title: it.title,
            summary: it.dek ?? null,
            meta: { outlet: it.outlet ?? "", age: ageString(it.publishedAt, nowMs) },
            url: it.url,
          })),
        };
        laneCounts[lane] = { shown: picked.length, collected: collectedByLane.get(lane) ?? picked.length };
      } else {
        // Live-but-empty (or errored) beats the stub scaffold: Stub Gazette
        // content would read as real news. The error note still shows.
        lanes[lane] = { title: NEWS_LANE_TITLES[lane] ?? lane, items: [] };
        laneCounts[lane] = { shown: 0, collected: collectedByLane.get(lane) ?? 0 };
      }
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

    // Sports + launches overwrite their stubs whenever attempted (§9.3/§9.11):
    // structured blocks, no selection. Empty teams/launches render with the
    // lane note, never Stub Gazette content.
    if (rawByAdapter.has("sports.espn")) {
      lanes["sports"] = { title: "Sports", teams: sportsTeams };
      laneCounts["sports"] = { shown: sportsTeams.length, collected: sportsTeams.length };
    }
    if (rawByAdapter.has("space.launches")) {
      lanes["launches"] = { title: "Launches", launches: launchItems };
      laneCounts["launches"] = { shown: launchItems.length, collected: launchItems.length };
    }

    // Releases (§9.4): films by date, new seasons always, new shows by
    // taste confidence, music calendar last. Tier-1 watchlist first.
    // Shared date formatter: full dates as "Oct 17", month/year precision
    // rendered honestly ("October 2026", "2026").
    const fmtRelease = (iso: string): string => {
      if (!iso) return "date TBA";
      if (/^\d{4}$/.test(iso)) return iso;
      if (/^\d{4}-\d{2}$/.test(iso)) {
        const d = new Date(iso + "-01T12:00:00");
        return d.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
      }
      const d = new Date(iso.slice(0, 10) + "T12:00:00");
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
    };
    if (rawByAdapter.has("entertainment.tmdb")) {
      const tmdbUrl = (id: string): string | undefined => {
        const m = id.match(/^tmdb:(movie|tv):(\d+)/);
        return m ? `https://www.themoviedb.org/${m[1] === "movie" ? "movie" : "tv"}/${m[2]}` : undefined;
      };
      const relItems: {
        id: string; title: string; summary: string | null;
        meta: { outlet: string; age: string }; url?: string;
      }[] = [];
      for (const m of tmdbMovies.filter((x) => x.tier === 1).slice(0, 5)) {
        relItems.push({
          id: m.id, title: m.title, summary: null,
          meta: { outlet: `Film · ${m.reason}`, age: fmtRelease(m.date) }, url: tmdbUrl(m.id),
        });
      }
      for (const s of tmdbSeasons) {
        relItems.push({
          id: s.id, title: s.title, summary: null,
          meta: { outlet: `TV · ${s.reason}`, age: fmtRelease(s.date) }, url: tmdbUrl(s.id),
        });
      }
      for (const m of tmdbMovies.filter((x) => x.tier === 2).slice(0, 3)) {
        relItems.push({
          id: m.id, title: m.title, summary: null,
          meta: { outlet: `Film · ${m.reason}`, age: fmtRelease(m.date) }, url: tmdbUrl(m.id),
        });
      }
      const rankedShows = [...tmdbCandidates].sort((a, b) => {
        const sa = tvScoreById.get(a.id)?.confidence ?? tvRulesById.get(a.id)?.confidence ?? 0;
        const sb = tvScoreById.get(b.id)?.confidence ?? tvRulesById.get(b.id)?.confidence ?? 0;
        return sb - sa;
      });
      for (const c of rankedShows.slice(0, 3)) {
        const s = tvScoreById.get(c.id);
        const reason = s?.reason ?? tvRulesById.get(c.id)?.reason ?? null;
        const short =
          reason && reason.length > 140 ? reason.slice(0, 139).replace(/\s+\S*$/, "") + "…" : reason;
        relItems.push({
          id: c.id, title: c.title,
          summary: short,
          meta: { outlet: "TV · new show", age: fmtRelease(c.date) }, url: tmdbUrl(c.id),
        });
      }
      lanes["releases"] = { title: "Coming up", items: relItems };
      laneCounts["releases"] = {
        shown: relItems.length,
        collected: tmdbMovies.length + tmdbSeasons.length + tmdbCandidates.length,
      };
    }

    // Music calendar rows join the releases lane (experiment 004).
    {
      const musicRaws = rawByAdapter.get("entertainment.music") ?? [];
      const musicItems: { id: string; title: string; summary: string | null; meta: { outlet: string; age: string } }[] = [];
      const insertMusic = db.prepare("INSERT INTO releases (run_id, kind, title, meta_json, date) VALUES (?, ?, ?, ?, ?)");
      for (const r of musicRaws) {
        const p = r.payload as {
          kind?: string;
          release?: { id?: string; artist?: string; title?: string; date?: string; precision?: string; kind?: string };
        };
        if (p.kind !== "release") continue;
        const rel = p.release;
        if (!rel?.id) continue;
        insertMusic.run(runId, "music", `${rel.artist} — ${rel.title}`, JSON.stringify({ artist: rel.artist, kind: rel.kind, precision: rel.precision }), rel.date ?? "");
        musicItems.push({
          id: rel.id,
          title: `${rel.artist} — ${rel.title}`,
          summary: null,
          meta: { outlet: `Music · ${rel.kind ?? "release"}`, age: fmtRelease(rel.date ?? "") },
        });
      }
      if (musicRaws.length > 0) {
        const cur = (lanes["releases"] as { title?: string; items?: unknown[] } | undefined)?.items ?? [];
        const counts = laneCounts["releases"] ?? { shown: 0, collected: 0 };
        lanes["releases"] = { title: "Coming up", items: [...cur, ...musicItems] };
        laneCounts["releases"] = {
          shown: counts.shown + musicItems.length,
          collected: counts.collected + musicRaws.filter((r) => (r.payload as { kind?: string }).kind === "release").length,
        };
      }
    }

    // Concerts (§9.4, experiment 003): own lane, date-ordered as matched.
    if (rawByAdapter.has("entertainment.concerts")) {
      const concertItems: { id: string; title: string; summary: string | null; meta: { outlet: string; age: string }; url?: string }[] = [];
      for (const r of rawByAdapter.get("entertainment.concerts") ?? []) {
        const c = (r.payload as { concert?: { id?: string; artist?: string; event?: string; date?: string; venue?: string; url?: string } }).concert;
        if (!c?.id) continue;
        concertItems.push({
          id: c.id,
          title: c.event ?? c.artist ?? "(untitled)",
          summary: null,
          meta: { outlet: [c.artist, c.venue].filter(Boolean).join(" · "), age: fmtRelease(c.date ?? "") },
          url: c.url || undefined,
        });
      }
      lanes["concerts"] = { title: "Concerts", items: concertItems };
      laneCounts["concerts"] = { shown: concertItems.length, collected: concertItems.length };
    }

    // Games (§9.12, experiment 012): sale rows only, deepest cut first.
    // Steam-only fallback rows are labeled; the lane note says which.
    if (rawByAdapter.has("entertainment.games")) {
      const gameItems: { id: string; title: string; summary: string | null; meta: { outlet: string; age: string }; url?: string }[] = [];
      let itadOk = true;
      const insertWish = db.prepare("INSERT INTO wishlist (run_id, appid, payload_json) VALUES (?, ?, ?)");
      for (const r of rawByAdapter.get("entertainment.games") ?? []) {
        const p = r.payload as {
          kind?: string;
          game?: {
            id?: string; appid?: number; name?: string; oldPrice?: string; newPrice?: string;
            pctOff?: number; shop?: string; historyLow?: string; newLow?: boolean; url?: string;
          };
          itadOk?: boolean;
        };
        if (p.kind === "games-summary") {
          itadOk = p.itadOk !== false;
          continue;
        }
        if (p.kind !== "game") continue;
        const g = p.game;
        if (!g?.id) continue;
        insertWish.run(runId, g.appid ?? 0, JSON.stringify(g));
        gameItems.push({
          id: g.id,
          title: g.name ?? "(untitled)",
          summary: [
            g.oldPrice && g.newPrice ? `${g.oldPrice} → ${g.newPrice} (${g.pctOff ?? 0}% off)` : null,
            g.newLow && g.historyLow ? "new historical low" : g.historyLow ? `hist. low ${g.historyLow}` : null,
          ].filter(Boolean).join(" · ") || null,
          meta: { outlet: g.shop ?? "", age: "" },
          url: g.url || undefined,
        });
      }
      if (!itadOk) {
        errors.push({ key: "games", message: "ITAD unreachable — Steam-store discounts only." });
      }
      lanes["games"] = { title: "Games", items: gameItems };
      laneCounts["games"] = { shown: gameItems.length, collected: gameItems.length };
    }

    // Holdings (§9.7, exp 008): earnings rows + ticker-tagged news picks.
    // Symbols with neither upcoming nor recent earnings stay quiet; thin-data
    // names render "no recent results" rather than stale rows.
    interface HoldingEarningRow {
      ticker: string;
      company: string;
      currency: string;
      upcoming: { date: string; estimated: boolean }[];
      recent: {
        date: string; epsActual: number | null; epsEstimate: number | null;
        surprisePct: number | null; revActual: number | null; revEstimate: number | null;
      } | null;
      thinData: boolean;
    }
    const holdingRaws = rawByAdapter.get("holdings.yahoo") ?? [];
    const earningsThrottled = holdingRaws.some(
      (r) => (r.payload as { kind?: string; throttled?: boolean }).kind === "earnings-status"
    );
    if (earningsThrottled) {
      errors.push({
        key: "holdings",
        message: "Yahoo throttled earnings dates — showing news only, retrying next run.",
      });
    }
    const earningRows: HoldingEarningRow[] = [];
    const insertEarning = db.prepare(
      "INSERT INTO earnings_events (run_id, ticker, payload_json) VALUES (?, ?, ?)"
    );
    const upsertHolding = db.prepare(
      "INSERT OR REPLACE INTO holdings (ticker, exchange, company) VALUES (?, ?, ?)"
    );
    let holdingsNewsCollected = 0;
    for (const r of holdingRaws) {
      const p = r.payload as {
        kind?: string;
        holding?: { userTicker?: string; company?: string };
        info?: {
          longName?: string; currency?: string;
          upcoming?: { date: string; estimated: boolean }[];
          recent?: HoldingEarningRow["recent"][];
          thinData?: boolean;
        };
      };
      if (p.kind === "news") {
        holdingsNewsCollected++;
        continue;
      }
      if (p.kind !== "earnings" || !p.holding?.userTicker || !p.info) continue;
      const info = p.info;
      const cfgHolding = config.holdings.find((h) => h.ticker === p.holding!.userTicker);
      upsertHolding.run(
        p.holding.userTicker,
        cfgHolding?.exchange ?? null,
        info.longName ?? p.holding.company ?? p.holding.userTicker
      );
      insertEarning.run(runId, p.holding.userTicker, JSON.stringify(info));
      const recent = (info.recent ?? [])[0] ?? null;
      if ((info.upcoming ?? []).length === 0 && !recent && !info.thinData) continue;
      earningRows.push({
        ticker: p.holding.userTicker,
        company: info.longName ?? p.holding.company ?? p.holding.userTicker,
        currency: info.currency ?? "",
        upcoming: info.upcoming ?? [],
        recent,
        thinData: info.thinData ?? false,
      });
    }
    earningRows.sort((a, b) => {
      const ad = a.upcoming[0]?.date ?? "9999";
      const bd = b.upcoming[0]?.date ?? "9999";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (b.recent?.date ?? "") < (a.recent?.date ?? "") ? -1 : 1;
    });
    if (rawByAdapter.has("holdings.yahoo")) {
      const holdingsPicks = (pickedByLane.get("holdings") ?? []).map((it) => ({
        id: it.id,
        title: it.title,
        summary: it.dek ?? null,
        meta: { outlet: it.outlet ?? "", age: ageString(it.publishedAt, nowMs) },
        tickers: it.tickers ?? [],
        url: it.url,
      }));
      lanes["holdings"] = { title: "Holdings", earnings: earningRows, items: holdingsPicks };
      laneCounts["holdings"] = {
        shown: earningRows.length + holdingsPicks.length,
        collected: holdingsNewsCollected + earningRows.length,
      };
    }

    snapshot.digest = { text: digest.text, generatedBy: digest.generatedBy };    // Real usage (§8, experiment 013): Luna dollars + per-provider requests.
    // usdToday is Backboard dollars ONLY — Gemini costs $0 and is reported as
    // requests against its 30 RPD cap.
    const lunaSpend = spendTodayUsd(db, dayPrefix, "backboard");
    const providersUsage: Record<string, { requestsToday: number; requestsCap: number; spentUsd: number }> = {};
    for (const [pid, p] of Object.entries(config.models.providers)) {
      providersUsage[pid] = {
        requestsToday: callsToday(db, dayPrefix, pid),
        requestsCap: p.requests_per_day,
        spentUsd: Math.round(spendTodayUsd(db, dayPrefix, pid) * 10_000) / 10_000,
      };
    }
    snapshot.cost = {
      usdToday: Math.round(lunaSpend * 10_000) / 10_000,
      capUsd: config.models.budget.daily_cap_usd,
      degraded: digest.generatedBy === "template" && config.models.stages.digests.mode === "llm",
      providers: providersUsage,
    };
    // Audit trail (§9.8): cut items with scores + reasons, capped per lane.
    const titleOf = (itemId: string): string | undefined =>
      (db.prepare("SELECT title FROM items WHERE id = ?").get(itemId) as { title: string } | undefined)?.title;
    const discarded: Record<string, { id: string; title: string; reason: string; ruleScore: number | null }[]> = {};
    for (const lane of pickedByLane.keys()) {
      const cuts = db
        .prepare(
          "SELECT item_id, reason, rule_score FROM selections WHERE run_id = ? AND lane = ? AND picked = 0 ORDER BY rule_score DESC LIMIT 8"
        )
        .all(runId, lane) as { item_id: string; reason: string | null; rule_score: number | null }[];
      if (cuts.length > 0) {
        discarded[lane] = cuts.map((c) => ({
          id: c.item_id,
          title: titleOf(c.item_id) ?? c.item_id,
          reason: c.reason ?? "cut",
          ruleScore: c.rule_score,
        }));
      }
    }
    snapshot.discarded = discarded;
    (snapshot as unknown as { laneStatus: Record<string, { ok: boolean; note: string | null }> }).laneStatus =
      Object.fromEntries(
        [...new Set([...laneStatusKeys(nfLaneList), ...errors.map((e) => e.key)])].map((key) => {
          const err = errors.find((e) => e.key === key);
          return [key, err ? { ok: false, note: err.message } : { ok: true, note: null }];
        })
      );

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

function laneKeysForAdapter(adapterId: string, subs: string[], nfLanes: string[]): string[] {
  if (adapterId === "weather.envcan") return ["weather.envcan"];
  if (adapterId === "weather.openmeteo") return ["weather.openmeteo"];
  if (adapterId === "weather.metno") return ["weather.metno"];
  if (adapterId === "news.newsflash") return nfLanes;
  if (adapterId === "spaceflight.news") return ["spaceflight"];
  if (adapterId === "space.launches") return ["launches"];
  if (adapterId === "sports.espn") return ["sports"];
  if (adapterId === "holdings.yahoo") return ["holdings"];
  if (adapterId === "entertainment.tmdb") return ["releases"];
  if (adapterId === "entertainment.music") return ["releases"];
  if (adapterId === "entertainment.concerts") return ["concerts"];
  if (adapterId === "entertainment.games") return ["games"];
  if (adapterId === "reddit.listings") return subs.map((s) => `reddit-${s}`);
  return [adapterId];
}

function laneStatusKeys(nfLanes: string[]): string[] {
  return ["weather.envcan", "weather.openmeteo", "weather.metno", ...nfLanes, "spaceflight", "sports", "launches", "holdings", "releases", "concerts", "games"];
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
