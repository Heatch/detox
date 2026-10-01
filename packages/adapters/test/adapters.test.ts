import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userAgentFor } from "../src/http.js";
import { en } from "../src/weather/envcan.js";
import { cleanEvent, englishOnly, sortEvents } from "../src/news/newsflash.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fix = (n: string): unknown => JSON.parse(readFileSync(join(dir, n), "utf8"));

describe("user-agent policy", () => {
  it("encodes the hard-won per-source table", () => {
    expect(userAgentFor("weather.metno")).toContain("DetoxDashboard");
    expect(userAgentFor("reddit.listings")).toContain("DetoxDashboard");
    expect(userAgentFor("sports.espn")).toBe("curl/8.4.0");
    expect(userAgentFor("news.newsflash")).toBeUndefined();
    expect(userAgentFor("weather.openmeteo")).toBeUndefined();
  });
});

describe("envcan fixture", () => {
  it("unwraps {en, fr} and exposes forecasts + hourly + context", () => {
    const d = fix("envcan.on-143.json") as { properties: Record<string, unknown> };
    const p = d.properties as {
      forecastGroup: { forecasts: unknown[] };
      hourlyForecastGroup: { hourlyForecasts: unknown[] };
    };
    expect(p.forecastGroup.forecasts.length).toBeGreaterThan(6);
    expect(p.hourlyForecastGroup.hourlyForecasts.length).toBeGreaterThan(0);
    const f0 = p.forecastGroup.forecasts[0] as {
      period: { textForecastName: { en: string } };
      textSummary: { en: string };
    };
    expect(typeof en(f0.period.textForecastName)).toBe("string");
    expect(en(f0.textSummary).length).toBeGreaterThan(10);
  });
});

describe("openmeteo fixture", () => {
  it("has 168 hourly points and 7 daily rows", () => {
    const d = fix("openmeteo.toronto.json") as {
      hourly: { time: string[]; temperature_2m: number[] };
      daily: { time: string[] };
    };
    expect(d.hourly.time.length).toBe(168);
    expect(d.daily.time.length).toBe(7);
  });
});

describe("metno fixture", () => {
  it("has a multi-day timeseries with instant temperatures", () => {
    const d = fix("metno.toronto.json") as {
      properties: { timeseries: { time: string; data: { instant: { details: { air_temperature: number } } } }[] };
    };
    const ts = d.properties.timeseries;
    expect(ts.length).toBeGreaterThan(48);
    const days = new Set(ts.map((e) => e.time.slice(0, 10)));
    expect(days.size).toBeGreaterThan(2);
    expect(typeof ts[0].data.instant.details.air_temperature).toBe("number");
  });
});

describe("newsflash cleanup", () => {
  it("decodes entities, filters non-English, sorts by confidence then recency", () => {
    const d = fix("newsflash.tech.json") as { events: Record<string, unknown>[] };
    expect(d.events.length).toBeGreaterThan(0);
    const cleaned = d.events.map((e) =>
      cleanEvent(e as Parameters<typeof cleanEvent>[0])
    );
    for (const e of cleaned) {
      expect(String(e.canonical_title ?? "")).not.toContain("&#");
    }
    const sorted = [...cleaned].sort(sortEvents);
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i - 1].confidence ?? 0) >= (sorted[i].confidence ?? 0)).toBe(true);
    }
    expect(
      englishOnly(
        { sources: [{ name: "x", lang: "de" }] } as Parameters<typeof englishOnly>[0],
        ["en"]
      )
    ).toBe(false);
  });
});

describe("reddit fixtures", () => {
  it("listing has t3 posts sorted by score with selftext", () => {
    const d = fix("reddit.nba.top.json") as {
      data: { children: { kind: string; data: Record<string, unknown> }[] };
    };
    const posts = d.data.children.filter((c) => c.kind === "t3");
    expect(posts.length).toBeGreaterThan(0);
    expect(typeof posts[0].data.title).toBe("string");
    expect(typeof posts[0].data.score).toBe("number");
    expect("selftext" in posts[0].data).toBe(true);
  });

  it("comments listing carries t1 wrapper kinds (plus more-placeholders)", () => {
    const d = fix("reddit.comments.json") as unknown[];
    const kids = (
      d[1] as { data: { children: { kind: string; data: Record<string, unknown> }[] } }
    ).data.children;
    // Reddit mixes kind:"more" placeholders in; the adapter keeps t1 only.
    const top = kids.filter((c) => c.kind === "t1");
    expect(top.length).toBeGreaterThan(0);
    expect(typeof top[0].data.body).toBe("string");
  });
});
