import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot, SnapshotItem, Trigger } from "@detox/core";

const LANES: { id: string; title: string; items: SnapshotItem[] }[] = [
  {
    id: "tech",
    title: "Tech",
    items: [
      { id: "stub-t1", title: "Postgres 19 ships with native columnar storage", summary: "The release adds columnar tables for analytical queries and lands a rewritten vacuum scheduler, the release notes say.", meta: { outlet: "Stub Gazette", age: "3 hours ago" }, url: "https://example.test/tech/1" },
      { id: "stub-t2", title: "Rust's next edition finalizes the async trait story", summary: "The language team merged the last of the async-in-traits work, removing the largest reason to reach for third-party crates.", meta: { outlet: "Stub Gazette", age: "6 hours ago" }, url: "https://example.test/tech/2" },
      { id: "stub-t3", title: "A CDN outage took out a dozen package registries", summary: "Three registries are still restoring package metadata, their status pages say.", meta: { outlet: "Stub Gazette", age: "11 hours ago" }, url: "https://example.test/tech/3" },
    ],
  },
  {
    id: "science",
    title: "Science",
    items: [
      { id: "stub-s1", title: "A cheap malaria vaccine clears a large three-country trial", summary: "Efficacy was 71 percent over two years, with the strongest results in the youngest cohort, the trial team reports.", meta: { outlet: "Stub Gazette", age: "5 hours ago" }, url: "https://example.test/science/1" },
      { id: "stub-s2", title: "Antarctic sea ice hits a record winter low for the third year", summary: "The measurement team calls the trend unambiguous and says the mechanism is still contested.", meta: { outlet: "Stub Gazette", age: "8 hours ago" }, url: "https://example.test/science/2" },
    ],
  },
  {
    id: "holdings",
    title: "Holdings",
    items: [
      { id: "stub-h1", title: "Shopify flags a logistics charge ahead of results", summary: "Analysts trimmed estimates after the pre-announcement, Reuters reports.", meta: { outlet: "Reuters", age: "4 hours ago" }, url: "https://example.test/holdings/1" },
      { id: "stub-h2", title: "Enbridge clears the last permit for its expansion", summary: "The approval removes the main regulatory obstacle named on the last call.", meta: { outlet: "Stub Gazette", age: "7 hours ago" }, url: "https://example.test/holdings/2" },
    ],
  },
  {
    id: "sports",
    title: "Raptors",
    items: [
      { id: "stub-r1", title: "Friday: vs Boston Celtics, 7:30 pm", summary: "Scotiabank Arena. Two players listed as questionable in the morning report.", meta: { outlet: "Stub Gazette", age: "this morning" }, url: "https://example.test/sports/1" },
    ],
  },
  {
    id: "releases",
    title: "Coming up",
    items: [
      { id: "stub-m1", title: "Night Signal — Halcyon Fields, album", summary: "Out October 9, per the label announcement.", meta: { outlet: "Stub Gazette", age: "Oct 9" }, url: "https://example.test/releases/1" },
      { id: "stub-m2", title: "Salt Flats — film, limited release in Toronto", summary: "Opens October 17, per the distributor.", meta: { outlet: "Stub Gazette", age: "Oct 17" }, url: "https://example.test/releases/2" },
    ],
  },
  {
    id: "reddit-nba",
    title: "r/nba",
    items: [
      { id: "stub-rn1", title: "The Raptors' bench rotation looks very different this year", summary: "412 comments. Top reply: the second unit finally has a rim protector.", meta: { outlet: "r/nba", age: "5 hours ago" }, url: "https://example.test/reddit/1" },
    ],
  },
  {
    id: "reddit-uwaterloo",
    title: "r/uwaterloo",
    items: [
      { id: "stub-ru1", title: "Winter course registration megathread", summary: "508 comments. Top reply: Quest opens at 8am sharp, have backups ready.", meta: { outlet: "r/uwaterloo", age: "3 hours ago" }, url: "https://example.test/reddit/2" },
    ],
  },
];

/** Stub snapshot generator: believable fake data for every Phase 0 lane. */
export function buildStubSnapshot(runId: number): Snapshot {
  const lanes: Record<string, unknown> = {};
  const laneCounts: Record<string, { shown: number; collected: number }> = {};
  for (const lane of LANES) {
    lanes[lane.id] = { title: lane.title, items: lane.items };
    laneCounts[lane.id] = { shown: lane.items.length, collected: lane.items.length * 9 + 7 };
  }
  lanes["weather"] = {
    title: "Weather",
    context: "A mix of sun and cloud. High 23.",
    locations: ["Toronto"],
    parts: [
      { name: "Morning", consensus: 16, sources: [null, 16, null] },
      { name: "Afternoon", consensus: 21, sources: [23, 21, 21] },
      { name: "Evening", consensus: 20, sources: [21, 20, 19] },
      { name: "Night", consensus: 18, sources: [20, 17, 18] },
    ],
  };
  laneCounts["weather"] = { shown: 1, collected: 3 };
  return {
    generatedAt: new Date().toISOString(),
    runId,
    laneCounts,
    digest: {
      text: "Good morning. Placeholder sources agree on temperature and disagree on rain, so take an umbrella. The Raptors open Friday with two players questionable.",
      generatedBy: "template",
    },
    laneStatus: {},
    lanes,
    cost: { usdToday: 0.011, capUsd: 0.05, degraded: false },
  };
}

export function writeSnapshot(dataDir: string, snapshot: Snapshot): string {
  const dir = join(dataDir, "snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = snapshot.generatedAt.replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2));
  copyFileSync(file, join(dir, "latest.json"));
  return file;
}
