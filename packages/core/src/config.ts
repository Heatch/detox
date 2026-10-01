import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { InterestsSchema, ModelsSchema, SettingsSchema, SourcesSchema } from "./types.js";
import type { Interests, Models, Settings, Sources } from "./types.js";

export interface Holding {
  ticker: string;
  exchange?: string;
  company?: string;
  note?: string;
}

// config/holdings.md: list items only; headings, blank lines, and HTML
// comments are ignored. `TSX:SHOP — Shopify` or `TSX:SHOP - note`.
export function parseHoldings(markdown: string): Holding[] {
  const out: Holding[] = [];
  let inComment = false;
  for (const rawLine of markdown.split("\n")) {
    let line = rawLine;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    const start = line.indexOf("<!--");
    if (start !== -1) {
      const end = line.indexOf("-->", start);
      if (end === -1) {
        inComment = true;
        line = line.slice(0, start);
      } else {
        line = line.slice(0, start) + line.slice(end + 3);
      }
    }
    const m = line.match(/^\s*[-*]\s+`?([A-Za-z0-9.:^=-]+)`?\s*(?:[—–-]\s*(.+))?\s*$/);
    if (!m) continue;
    const ticker = m[1].trim();
    const rest = (m[2] ?? "").trim();
    const colon = ticker.indexOf(":");
    out.push({
      ticker,
      exchange: colon > 0 ? ticker.slice(0, colon) : undefined,
      company: rest || undefined,
    });
  }
  return out;
}

export function isEtf(holding: Holding, exclude: string[]): boolean {
  const bare = holding.ticker.includes(":") ? holding.ticker.split(":").slice(1).join(":") : holding.ticker;
  const company = (holding.company ?? "").toUpperCase();
  return exclude.some((pattern) => {
    const p = pattern.toUpperCase();
    if (bare.toUpperCase() === p || holding.ticker.toUpperCase() === p) return true;
    // Word-boundary match on the company name ("XEN" must not match "Xenon"...,
    // but "ETF" in the name is itself a signal).
    return company.includes(" ETF") || new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(company);
  });
}

function readYaml<T>(repoRoot: string, rel: string): unknown {
  return parseYaml(readFileSync(join(repoRoot, rel), "utf8"));
}

export interface LoadedConfig {
  interests: Interests;
  settings: Settings;
  models: Models;
  sources: Sources;
  holdings: Holding[];
  env: Record<string, string>;
}

export function loadConfig(repoRoot: string): LoadedConfig {
  const interests = InterestsSchema.parse(readYaml(repoRoot, "config/interests.yaml"));
  const settings = SettingsSchema.parse(readYaml(repoRoot, "config/settings.yaml"));
  const models = ModelsSchema.parse(readYaml(repoRoot, "config/models.yaml"));
  const sources = SourcesSchema.parse(readYaml(repoRoot, "config/sources.yaml"));
  // holdings.md is markdown, not YAML — parse the raw text only.
  const holdings = parseHoldings(readText(repoRoot, "config/holdings.md"));
  const env = loadEnv(repoRoot);
  return { interests, settings, models, sources, holdings, env };
}

function readText(repoRoot: string, rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

// .env loader — the only place secrets are read (plan §11). Simple
// KEY="value" / KEY=value lines; # comments; no variable expansion.
export function loadEnv(repoRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  let text: string;
  try {
    text = readText(repoRoot, ".env");
  } catch {
    return env;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}
