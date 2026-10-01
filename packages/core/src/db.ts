import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    est_cost_usd REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS raw_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    adapter TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    dek TEXT,
    content TEXT,
    published_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    outlet TEXT,
    tier INTEGER NOT NULL DEFAULT 2,
    engagement_json TEXT,
    location TEXT,
    tickers_json TEXT,
    raw_ref INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane TEXT NOT NULL,
    label TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_items (
    cluster_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (cluster_id, item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS selections (
    run_id INTEGER NOT NULL,
    lane TEXT NOT NULL,
    item_id TEXT NOT NULL,
    picked INTEGER NOT NULL,
    rule_score REAL,
    llm_score REAL,
    rationale TEXT,
    summary TEXT,
    reason TEXT,
    PRIMARY KEY (run_id, lane, item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS weather_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    location TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS weather_consensus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    location TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    team TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS injuries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    team TEXT NOT NULL,
    player TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    return_date TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    meta_json TEXT,
    date TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS holdings (
    ticker TEXT PRIMARY KEY,
    exchange TEXT,
    company TEXT,
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS earnings_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    est_cost_usd REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    value INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings_snapshot (
    run_id INTEGER PRIMARY KEY,
    payload_json TEXT NOT NULL
  )`,
];

export type Db = Database.Database;

export interface RunRow {  id: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
}

export function openDb(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "detox.db"));
  db.pragma("journal_mode = WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

export function insertRun(db: Database.Database, trigger: string, startedAt: string): number {
  const r = db
    .prepare("INSERT INTO runs (trigger, started_at, status) VALUES (?, ?, 'running')")
    .run(trigger, startedAt);
  return Number(r.lastInsertRowid);
}

export function finishRun(
  db: Database.Database,
  id: number,
  status: string,
  finishedAt: string,
  error?: string
): void {
  db.prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(
    status,
    finishedAt,
    error ?? null,
    id
  );
}

export function lastSuccessfulRun(db: Database.Database): RunRow | undefined {
  return db
    .prepare("SELECT * FROM runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1")
    .get() as RunRow | undefined;
}

export function spendTodayUsd(db: Database.Database, dayPrefix: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(est_cost_usd), 0) AS total FROM llm_calls WHERE run_id IN (SELECT id FROM runs WHERE started_at LIKE ?)")
    .get(dayPrefix + "%") as { total: number };
  return row.total;
}

export function callsToday(db: Database.Database, dayPrefix: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE run_id IN (SELECT id FROM runs WHERE started_at LIKE ?)")
    .get(dayPrefix + "%") as { n: number };
  return row.n;
}

export function recordLlmCall(
  db: Database.Database,
  call: {
    run_id: number;
    stage: string;
    model: string;
    provider: string;
    tokens_in?: number;
    tokens_out?: number;
    cache_hit?: number;
    latency_ms?: number;
    est_cost_usd?: number;
  }
): void {
  db.prepare(
    `INSERT INTO llm_calls (run_id, stage, model, provider, tokens_in, tokens_out, cache_hit, latency_ms, est_cost_usd)
     VALUES (@run_id, @stage, @model, @provider, @tokens_in, @tokens_out, @cache_hit, @latency_ms, @est_cost_usd)`
  ).run({
    tokens_in: 0,
    tokens_out: 0,
    cache_hit: 0,
    latency_ms: null,
    est_cost_usd: 0,
    ...call,
  });
}
