import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userAgentFor } from "../src/http.js";
import { en } from "../src/weather/envcan.js";
import { cleanEvent, englishOnly, sortEvents } from "../src/news/newsflash.js";
import { parseGames, parseInjuries } from "../src/sports/espn.js";
import { parseLaunch } from "../src/space/launches.js";
import { isPromo, parseRss, resolveHolding } from "../src/finance/yahoo.js";
import { parseEarnings } from "../src/finance/earnings.js";
import { extractQuotePage } from "../src/finance/earnings.js";
import { inWindow, newSeasonSignal, rulesConfidence } from "../src/entertainment/tmdb.js";
import { matchConcerts } from "../src/entertainment/concerts.js";
import { bestDeal } from "../src/games/steam_itad.js";
import { releaseKind } from "../src/entertainment/music.js";

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
  it("pins the plain-library UA for every sports.espn call shape", () => {
    expect(userAgentFor("sports.espn:schedule")).toBe("curl/8.4.0");
  });
});

describe("espn schedule", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const ev = (over: Record<string, unknown>) => ({
    date: "2026-10-10T22:30Z",
    name: "LA Clippers at Toronto Raptors",
    seasonType: { abbreviation: "pre" },
    competitions: [
      {
        status: { type: { name: "STATUS_SCHEDULED", detail: "Sat, October 10th at 6:30 PM EDT" } },
        venue: { fullName: "Rogers Arena", address: { city: "Vancouver" } },
        broadcasts: [],
      },
    ],
    ...over,
  });
  it("keeps scheduled, drops final, labels preseason", () => {
    const final = ev({ date: "2026-10-03T23:00Z", competitions: [{ status: { type: { name: "STATUS_FINAL", detail: "Final" } } }] });
    const games = parseGames([final, ev({}), ev({ date: "2026-10-13T23:00Z" })] as never, 5, now);
    expect(games).toHaveLength(2);
    expect(games[0].preseason).toBe(true);
    expect(games[0].venue).toBe("Rogers Arena");
    expect(games[0].detail).toContain("October 10th");
  });
  it("drops past games and caps at upcoming_max", () => {
    const games = parseGames([ev({}), ev({}), ev({})] as never, 2, now);
    expect(games).toHaveLength(2);
    expect(parseGames([ev({ date: "2026-10-01T00:00Z" })] as never, 5, now)).toHaveLength(0);
  });
});

describe("espn injuries", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const group = {
    displayName: "Toronto Raptors",
    injuries: [
      {
        athlete: { displayName: "Nate Bittle" },
        status: "Day-To-Day",
        date: "2026-10-04T02:56Z",
        shortComment: "Bittle (foot) did not play in Saturday's loss.",
        details: { type: "Foot", returnDate: "2026-10-10" },
      },
      {
        athlete: { displayName: "Junk Comment" },
        status: "Out",
        date: "2026-10-04T02:56Z",
        shortComment: "ir-nr",
        details: { type: "Knee", side: "Left", returnDate: "2026-11-01" },
      },
      {
        athlete: { displayName: "Healthy Scratch" },
        status: "Out",
        date: "2026-10-04T02:56Z",
        shortComment: "Coach's decision.",
        details: { type: "Coach's Decision" },
      },
      {
        athlete: { displayName: "Padded Date" },
        status: "Out",
        date: "2026-10-04T02:56Z",
        shortComment: "Out for the season.",
        details: { type: "Back", returnDate: "2028-05-01" },
      },
    ],
  };
  it("finds the team group, composes junk comments, keeps non-injuries labeled", () => {
    const { injuries, groupFound } = parseInjuries([group] as never, "Toronto Raptors", now);
    expect(groupFound).toBe(true);
    expect(injuries).toHaveLength(4);
    expect(injuries[0].note).toContain("did not play");
    expect(injuries[0].returnDate).toBe("2026-10-10");
    expect(injuries[1].note).toBe("Knee, Left");
    expect(injuries[2].status).toContain("Coach's Decision");
    expect(injuries[3].returnDate).toBeNull();
  });
  it("reports a missing group instead of guessing", () => {
    expect(parseInjuries([group] as never, "Toronto Maple Leafs", now)).toMatchObject({
      groupFound: false,
      injuries: [],
    });
  });
});

describe("launch library", () => {
  it("maps a launch row and rejects rows without id/net", () => {
    const row = parseLaunch({
      id: 1,
      name: "Falcon 9 Block 5 | Test",
      net: "2026-10-05T08:17:00Z",
      status: { abbrev: "Go" },
      launch_service_provider: { name: "SpaceX" },
      rocket: { configuration: { full_name: "Falcon 9 Block 5" } },
      mission: { name: "Test Mission" },
      pad: { name: "SLC-4E", location: { name: "Vandenberg" } },
      webcast_live: true,
      probability: null,
    } as never);
    expect(row).toMatchObject({
      id: "ll:1",
      vehicle: "Falcon 9 Block 5",
      provider: "SpaceX",
      status: "Go",
      webcast: true,
      probability: null,
    });
    expect(parseLaunch({ name: "no id" } as never)).toBeNull();
    expect(parseLaunch({ id: 2 } as never)).toBeNull();
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

describe("holdings symbol resolution", () => {
  it("maps TSX, class shares, CDRs, bare tickers; excludes ETFs", () => {
    expect(resolveHolding({ ticker: "TSX:DOL", exchange: "TSX" })).toMatchObject({
      userTicker: "TSX:DOL",
      yahooSymbol: "DOL.TO",
    });
    expect(resolveHolding({ ticker: "TSX:HMM.A", exchange: "TSX" })).toMatchObject({
      yahooSymbol: "HMM-A.TO",
    });
    expect(resolveHolding({ ticker: "NEO:NVON", exchange: "NEO" })).toMatchObject({
      userTicker: "NEO:NVON",
      yahooSymbol: "NVO",
    });
    expect(resolveHolding({ ticker: "NEO:COST", exchange: "NEO" })).toMatchObject({
      yahooSymbol: "COST",
    });
    expect(resolveHolding({ ticker: "FN" })).toMatchObject({ yahooSymbol: "FN" });
    expect(resolveHolding({ ticker: "TSX:XEN", exchange: "TSX" })).toMatchObject({ excluded: "ETF" });
    expect(resolveHolding({ ticker: "NLR" })).toMatchObject({ excluded: "ETF" });
  });
});

describe("holdings rss", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Dollarama beats Q3 estimates]]></title><link>https://finance.yahoo.com/news/x-1.html</link><pubDate>Sat, 04 Oct 2026 12:00:00 GMT</pubDate></item>
    <item><title>Should you buy this retail stock now?</title><link>https://seekingalpha.com/article/y</link><pubDate>Sat, 04 Oct 2026 11:00:00 GMT</pubDate></item>
    <item><title>No link here</title><pubDate>Sat, 04 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  it("parses items, decodes CDATA, skips linkless rows", () => {
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Dollarama beats Q3 estimates", source: "finance.yahoo.com" });
  });
  it("cuts promo domains and opinion-bait titles", () => {
    const items = parseRss(xml);
    expect(isPromo(items[0])).toBe(false);
    expect(isPromo(items[1])).toBe(true);
    expect(isPromo({ title: "Analyst upgrades price target", link: "https://x.test/a", pubDate: "", source: "" })).toBe(true);
    expect(isPromo({ title: "What Jim Cramer says about retail", link: "https://finance.yahoo.com/x", pubDate: "", source: "" })).toBe(true);
    expect(isPromo({ title: "Retail sales rise in March", link: "https://thestreet.com/x", pubDate: "", source: "" })).toBe(true);
  });
});

describe("holdings earnings", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const result = {
    price: { longName: "Dollarama Inc.", currency: "CAD" },
    earnings: {
      financialCurrency: "CAD",
      earningsChart: {
        quarterly: [
          { date: "2026-06-30", actual: { raw: 1.0 }, estimate: { raw: 0.95 }, revenue: { actual: { raw: 100 }, estimate: { raw: 98 } } },
          { date: "2026-10-02", actual: { raw: 1.2 }, estimate: { raw: 1.0 }, revenue: { actual: { raw: 120 }, estimate: { raw: 110 } } },
        ],
      },
    },
    calendarEvents: {
      earnings: {
        earningsDate: [{ raw: Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000) }],
        isEarningsDateEstimate: true,
      },
    },
  };
  it("finds upcoming dates, recent results with surprise, currency and name", () => {
    const info = parseEarnings("DOL.TO", result as never, now);
    expect(info.longName).toBe("Dollarama Inc.");
    expect(info.currency).toBe("CAD");
    expect(info.upcoming).toEqual([{ date: "2026-10-20", estimated: true }]);
    expect(info.recent).toHaveLength(1);
    expect(info.recent[0]).toMatchObject({ epsActual: 1.2, epsEstimate: 1.0, surprisePct: 20 });
    expect(info.thinData).toBe(false);
  });
  it("flags thin data instead of rendering stale rows", () => {
    const thin = parseEarnings("HMM-A.TO", { earnings: { earningsChart: { quarterly: [] } }, calendarEvents: {} } as never, now);
    expect(thin.thinData).toBe(true);
    expect(thin.recent).toHaveLength(0);
    expect(thin.upcoming).toHaveLength(0);
  });
  it("prefers reportedDate over quarter labels and accepts string surprise", () => {
    const info = parseEarnings(
      "X.TO",
      {
        price: { longName: "X Inc." },
        earnings: {
          financialCurrency: "CAD",
          earningsChart: {
            quarterly: [
              {
                date: "2Q2026",
                actual: { raw: 1.29 },
                estimate: { raw: 1.26445 },
                surprisePct: "2.02",
                revenue: {},
                periodEndDate: { raw: 1785456000 },
                reportedDate: { raw: 1789556400 },
              },
            ],
          },
        },
        calendarEvents: {},
      } as never,
      Date.parse("2026-09-18T12:00:00Z")
    );
    expect(info.thinData).toBe(false);
    expect(info.recent).toHaveLength(1);
    expect(info.recent[0]).toMatchObject({ date: "2026-09-16", surprisePct: 2.02 });
  });
});

describe("quote page extraction", () => {
  // Escaped store bytes modeled on the real quote page (single backslashes).
  const html = `<title>Dollarama Inc. (DOL.TO) Stock Price - Yahoo Finance</title>` +
    `\\"earningsDate\\":[{\\"raw\\":1796905800,\\"fmt\\":\\"2026-12-10\\"}],\\"isEarningsDateEstimate\\":true` +
    `\\"financialCurrency\\":\\"CAD\\"` +
    `\\"earningsChart\\":{\\"quarterly\\":[{\\"date\\":\\"2Q2026\\",\\"actual\\":{\\"raw\\":1.29},\\"estimate\\":{\\"raw\\":1.26},\\"surprisePct\\":\\"2.02\\",\\"reportedDate\\":{\\"raw\\":1789556400}}]}`;
  it("builds a quoteSummary-shaped result from escaped page bytes", () => {
    const result = extractQuotePage(html, "DOL.TO")!;
    expect(result).not.toBeNull();
    const info = parseEarnings("DOL.TO", result, Date.parse("2026-11-15T12:00:00Z"));
    expect(info.longName).toBe("Dollarama Inc.");
    expect(info.currency).toBe("CAD");
    expect(info.upcoming).toEqual([{ date: "2026-12-10", estimated: true }]);
    expect(info.recent).toHaveLength(0);
    expect(info.thinData).toBe(false);
  });
  it("returns null when the store is absent and anchors quarterly on earningsChart", () => {
    expect(extractQuotePage("<title>X (Y) - Yahoo Finance</title>no store here", "Y")).toBeNull();
    const decoy = `\\"financialsChart\\":{\\"quarterly\\":[{\\"date\\":\\"2020\\"}]}` + html;
    const result = extractQuotePage(decoy, "DOL.TO")!;
    const info = parseEarnings("DOL.TO", result, Date.parse("2026-09-18T12:00:00Z"));
    expect(info.recent[0]?.epsActual).toBe(1.29);
  });
});

describe("tmdb seasons", () => {
  const det = (over: Record<string, unknown>) => ({
    id: 1,
    name: "Show",
    status: "Returning Series",
    next_episode_to_air: null,
    genres: [],
    networks: [],
    creators: [],
    seasons: [],
    ...over,
  });
  it("reads the seasons tail, not next_episode_to_air", () => {
    expect(
      newSeasonSignal("Show", det({ seasons: [{ season_number: 2, air_date: "2025-01-16" }, { season_number: 3, air_date: null }] }) as never)
    ).toMatchObject({ reason: "Season 3 announced, no date yet" });
    expect(
      newSeasonSignal("Show", det({ seasons: [{ season_number: 3, air_date: "2027-03-01" }] }) as never)
    ).toMatchObject({ reason: "Season 3 starts 2027-03-01" });
    expect(
      newSeasonSignal("Show", det({ seasons: [{ season_number: 2, air_date: "2025-01-16" }] }) as never)
    ).toBeNull();
    expect(
      newSeasonSignal("Show", det({ status: "Ended", seasons: [{ season_number: 3, air_date: null }] }) as never)
    ).toBeNull();
  });
  it("windows dates inclusively", () => {
    expect(inWindow("2026-10-04", "2026-10-04", "2026-12-03")).toBe(true);
    expect(inWindow(undefined, "2026-10-04", "2026-12-03")).toBe(false);
  });
});

describe("tmdb rules confidence", () => {
  const profile = {
    genres: new Map([["Drama", 5], ["Comedy", 3]]),
    creators: new Set(["Dan Erickson"]),
    networks: new Set(["Apple TV"]),
    lovedTitles: ["Severance"],
  };
  it("scores genre overlap with creator/network bonuses", () => {
    const r = rulesConfidence(profile, { genres: ["Drama", "Mystery"], creators: ["Dan Erickson"], networks: ["Apple TV"] });
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.reason).toContain("Drama");
    const cold = rulesConfidence(profile, { genres: ["Sport"] });
    expect(cold.confidence).toBeLessThan(0.3);
  });
  it("degrades to baseline without a profile", () => {
    const r = rulesConfidence({ genres: new Map(), creators: new Set(), networks: new Set(), lovedTitles: [] }, { genres: ["Drama"] });
    expect(r.confidence).toBe(0.5);
  });
});

describe("concert matching", () => {
  const ev = (name: string, attractions: string[], date = "2026-11-01") => ({
    id: name, name, url: "", dates: { start: { localDate: date } },
    _embedded: { attractions: attractions.map((a) => ({ name: a })), venues: [{ name: "Hall" }] },
  });
  it("matches attractions, rejects tributes, filters dates, sorts", () => {
    const rows = matchConcerts(
      [
        ev("e1", ["Taylor Swift"], "2026-11-20"),
        ev("e2", ["Taylor Swift Tribute"], "2026-11-21"),
        ev("e3", ["Tyla"], "2026-08-01"),
        ev("e4", ["Doja Cat"], "2026-10-10"),
      ] as never,
      ["Taylor Swift", "Tyla", "Doja Cat"],
      "2026-10-04",
      "2026-12-03"
    );
    expect(rows.map((r) => r.id)).toEqual(["tm:e4", "tm:e1"]);
    expect(rows[0]).toMatchObject({ artist: "Doja Cat" });
  });
});

describe("games best deal", () => {
  it("takes the minimum across shops, never shop-assumed", () => {
    const best = bestDeal(
      [
        { price: { amount: 4054, currency: "USD" }, regular: { amount: 5000 }, cut: 19, shop: { name: "Steam" } },
        { price: { amount: 3650, currency: "USD" }, regular: { amount: 5000 }, cut: 27, shop: { name: "GamesPlanet US" } },
        { price: {}, regular: { amount: 5000 } },
      ] as never,
      "USD"
    )!;
    expect(best.shop).toBe("GamesPlanet US");
    expect(best.pctOff).toBe(27);
    expect(bestDeal([], "USD")).toBeNull();
  });
});

describe("music release kinds", () => {
  it("tags deluxe, reissue, soundtrack, compilation, ep honestly", () => {
    expect(releaseKind("Album", [], "Showgirl: The Encore")).toBe("deluxe");
    expect(releaseKind("Album", [], "Rubber Soul Super Deluxe")).toBe("reissue");
    expect(releaseKind("Album", ["Soundtrack"], "GTA VI Tracks")).toBe("soundtrack");
    expect(releaseKind("Album", ["Compilation"], "Greatest Hits")).toBe("compilation");
    expect(releaseKind("EP", [], "Something")).toBe("ep");
    expect(releaseKind("Album", [], "Plain Album")).toBe("album");
    expect(releaseKind("Single", [], "New Song")).toBe("single");
  });
});
