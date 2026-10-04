import { describe, expect, it } from "vitest";
import { parseHoldings, isEtf } from "../src/config.js";
import { canonicalItemId } from "../src/types.js";
import { checkBudget } from "../src/budget.js";
import { InterestsSchema, SettingsSchema, ModelsSchema } from "../src/types.js";

describe("holdings parser", () => {
  const md = `# Holdings

## Tickers

<!-- auto-generated, do not edit -->
- TSX:HMM.A — Hammond Manufacturing Co. Ltd. (Class A)
- NEO:NVON — Novo Nordisk CDR (CAD Hedged)
- TSX:XEN — iShares Jantzi Social Index ETF
- FN — FABRINET
- not a holding line
`;
  it("parses tickers, exchanges, and notes; skips comments and prose", () => {
    const h = parseHoldings(md);
    expect(h.map((x) => x.ticker)).toEqual(["TSX:HMM.A", "NEO:NVON", "TSX:XEN", "FN"]);
    expect(h[0]).toMatchObject({ exchange: "TSX", company: "Hammond Manufacturing Co. Ltd. (Class A)" });
    expect(h[1]).toMatchObject({ exchange: "NEO" });
    expect(h[3]).toMatchObject({ exchange: undefined, company: "FABRINET" });
  });

  it("flags ETFs for exclusion", () => {
    const h = parseHoldings(md);
    const etf = h.find((x) => x.ticker === "TSX:XEN")!;
    expect(isEtf(etf, ["CBIL", "XEN", "NLR"])).toBe(true);
    expect(isEtf(h[0], ["CBIL", "XEN", "NLR"])).toBe(false);
  });
});

describe("canonicalItemId", () => {
  it("prefers explicit ids (nf:<event_id>)", () => {
    expect(canonicalItemId({ id: "nf:123", url: "https://x.test/a" })).toBe("nf:123");
  });
  it("hashes the canonical url deterministically", () => {
    const a = canonicalItemId({ url: "https://x.test/a?utm=x" });
    const b = canonicalItemId({ url: "https://x.test/a?utm=x" });
    const c = canonicalItemId({ url: "https://x.test/b" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("url:")).toBe(true);
  });
});

describe("budget guard", () => {
  // Gemini pool: dollars uncapped ($0), requests bind. Luna pool: requests
  // generous, dollars bind (experiment 013).
  const gemini = { dailyCapUsd: 0, spentUsdToday: 0, requestsToday: 3, requestsPerDayCap: 30, rpm: 5 };
  const luna = { dailyCapUsd: 0.05, spentUsdToday: 0.01, requestsToday: 3, requestsPerDayCap: 10000, rpm: 500 };
  it("allows llm under both caps", () => {
    expect(checkBudget(gemini, "llm", 0)).toMatchObject({ allowed: true, degraded: false });
    expect(checkBudget(luna, "llm", 0.001)).toMatchObject({ allowed: true, degraded: false });
  });
  it("degrades over the dollar cap (Luna)", () => {
    const d = checkBudget({ ...luna, spentUsdToday: 0.0499 }, "llm", 0.001);
    expect(d).toMatchObject({ allowed: false, degraded: true });
    expect(d.reason).toContain("cap");
  });
  it("degrades over the request cap (Gemini 30 RPD)", () => {
    const d = checkBudget({ ...gemini, requestsToday: 30 }, "llm", 0);
    expect(d).toMatchObject({ allowed: false, degraded: true });
  });
  it("never runs llm in rules-only/off modes", () => {
    expect(checkBudget(gemini, "rules-only", 0).allowed).toBe(false);
    expect(checkBudget(gemini, "off", 0).allowed).toBe(false);
  });
});

describe("config schemas", () => {
  it("rejects a reddit block with no subreddits", () => {
    const bad = {
      reddit: { subreddits: [], top_n: 5 },
      holdings: "config/holdings.md",
      weather: { locations: [], default_location: "toronto", day_parts: {} },
    };
    expect(() => InterestsSchema.parse(bad)).toThrow();
  });
  it("accepts minimal valid settings", () => {
    const s = SettingsSchema.parse({
      refresh: { on_open_stale_after_hours: 24, daily_at: "09:00", skip_if_run_within_hours: 3 },
      windows: {},
      llm: {},
      audit: {},
    });
    expect(s.timezone).toBe("America/Toronto");
  });
  it("requires providers plus all five model stages", () => {
    const bad = {
      providers: { backboard: { base_url: "https://x.test", key_env: "K", transport: "backboard-threads" } },
      models: { bulk: "a", interactive: "b" },
      stages: { digests: { model: "a", mode: "llm" } },
      budget: {},
    };
    expect(() => ModelsSchema.parse(bad)).toThrow();
  });
  it("accepts the two-provider shape with model→provider mapping", () => {
    const ok = {
      providers: {
        "google-ai-studio": { base_url: "https://x.test", key_env: "K", transport: "openai-shim", rpm: 5, requests_per_day: 30 },
        backboard: { base_url: "https://y.test", key_env: "K2", transport: "backboard-threads", llm_provider: "openai" },
      },
      models: { bulk: "gemini-3.8-flash", interactive: "gpt-5.6-luna" },
      model_providers: { bulk: "google-ai-studio", interactive: "backboard" },
      stages: {
        select: { model: "bulk", mode: "rules-only" },
        summarize: { model: "bulk", mode: "rules-only" },
        dedupe: { model: "interactive", mode: "rules-only" },
        digests: { model: "bulk", mode: "llm" },
        taste: { model: "bulk", mode: "llm" },
      },
      budget: {},
    };
    const parsed = ModelsSchema.parse(ok);
    expect(parsed.model_providers.bulk).toBe("google-ai-studio");
    expect(parsed.providers["google-ai-studio"].requests_per_day).toBe(30);
  });
});
