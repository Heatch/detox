import { describe, expect, it } from "vitest";
import { canonicalizeUrl, normalizeTitle, ageString } from "../src/normalize.js";
import { dedupe, scoreItems, selectTop } from "../src/select.js";
import {
  buildParts,
  envcanDaily,
  expandParts,
  median,
  spreadNote,
} from "../src/weather.js";
import type { CanonicalItem } from "@detox/core";

function item(over: Partial<CanonicalItem> & { id: string }): CanonicalItem {
  return {
    lane: "tech",
    sourceId: "test",
    url: "https://example.test/" + over.id,
    canonicalUrl: "https://example.test/" + over.id,
    title: "Title " + over.id,
    publishedAt: "2026-10-01T00:00:00Z",
    fetchedAt: "2026-10-01T01:00:00Z",
    tier: 2,
    rawRef: 0,
    ...over,
  };
}

describe("normalize helpers", () => {
  it("strips tracking params, keeps the rest", () => {
    expect(canonicalizeUrl("https://x.test/a?utm_source=n&fbclid=1&q=2")).toBe("https://x.test/a?q=2");
  });
  it("normalizes titles for comparison", () => {
    expect(normalizeTitle("Hello,  World!")).toBe("hello world");
  });
  it("formats ages", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(ageString("2026-10-01T11:30:00Z", now)).toBe("30 minutes ago");
    expect(ageString("2026-10-01T09:00:00Z", now)).toBe("3 hours ago");
    expect(ageString("2026-09-30T12:00:00Z", now)).toBe("Yesterday");
  });
});

describe("dedupe", () => {
  it("collapses nf identity, URL equality, and title equality", () => {
    const a = item({ id: "nf:1", title: "Same Story" });
    const b = item({ id: "nf:1", title: "Same Story edited" });
    const c = item({ id: "x", title: "Same Story", url: "https://y.test/other", canonicalUrl: "https://y.test/other" });
    const d = item({ id: "y", title: "Different" });
    const { items, clusterSize } = dedupe([a, b, c, d]);
    expect(items.map((i) => i.id)).toEqual(["nf:1", "y"]);
    expect(clusterSize.get("nf:1")).toBe(3);
  });
});

describe("select", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const mk = (id: string, title: string, score?: number) =>
    item({ id, title, publishedAt: "2026-10-01T11:00:00Z", engagement: score ? { score } : undefined });
  it("takes the budget best and keeps cuts with reasons", () => {
    const items = [mk("a", "crypto prices crash again"), mk("b", "plain story"), mk("c", "plain story 2")];
    const scored = scoreItems({
      lane: "tech", items, clusterSize: new Map(),
      topics: {}, negatives: ["crypto prices"], budget: [3, 5], nowMs: now,
    });
    const picks = selectTop(scored, [1, 2]);
    expect(picks.get("b")!.picked).toBe(true);
    expect(picks.get("a")!.picked).toBe(false);
    expect(picks.get("a")!.reason).toContain("negative filter");
  });
  it("rewards corroboration and engagement", () => {
    const items = [mk("a", "solo", 1), mk("b", "big", 100)];
    const scored = scoreItems({
      lane: "tech", items, clusterSize: new Map([["b", 5]]),
      topics: {}, negatives: [], budget: [3, 5], nowMs: now,
    });
    const byId = Object.fromEntries(scored.map((s) => [s.item.id, s]));
    expect(byId.b.score).toBeGreaterThan(byId.a.score);
    expect(byId.b.reasons.join(" ")).toContain("5 outlets");
  });
});

describe("weather math", () => {
  it("medians and means ignore nulls", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([null, undefined])).toBeNull();
  });
  it("night wraps past midnight into tonight", () => {
    const parts = expandParts({ night: [22, 6], morning: [6, 12] });
    const pts = [
      { date: "2026-09-30", hour: 21, temp: 19 },
      { date: "2026-09-30", hour: 23, temp: 17 },
      { date: "2026-10-01", hour: 2, temp: 15 },
      { date: "2026-10-01", hour: 8, temp: 12 },
    ];
    const cells = buildParts({ s: pts }, parts, "2026-09-30");
    const night = cells.find((c) => c.name === "night")!;
    expect(night.sources.s).toBe(16); // mean(17, 15), not polluted by 21:00 or 08:00
    expect(night.consensus).toBe(16);
  });
  it("pairs EC periods starting with tonight's low", () => {    const rows = envcanDaily({
      forecastGroup: {
        forecasts: [
          { period: { value: { en: "Wednesday night" } }, temperatures: { temperature: [{ class: { en: "low" }, value: { en: 17 } }] } },
          { period: { value: { en: "Thursday" } }, temperatures: { temperature: [{ class: { en: "high" }, value: { en: 23 } }] } },
          { period: { value: { en: "Thursday night" } }, temperatures: { temperature: [{ class: { en: "low" }, value: { en: 14 } }] } },
        ],
      },
    });
    expect(rows).toEqual([
      { day: "Wednesday night", high: null, low: 17 },
      { day: "Thursday", high: 23, low: 14 },
    ]);
  });
  it("spread notes only fire past the threshold", () => {
    expect(spreadNote([21, 23], 3)).toBeUndefined();
    expect(spreadNote([18, 21.4], 3)).toBe("18° to 21.4°");
  });
});
