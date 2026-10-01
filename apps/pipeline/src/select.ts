import type { CanonicalItem, LaneId } from "@detox/core";
import { normalizeTitle } from "./normalize.js";

// Dedupe (identity/lexical only — LLM tie-break deferred per decision).
// nf: ids collapse by definition; otherwise canonical-URL equality first,
// then normalized-title equality. Returns kept items + cluster sizes.

export interface DedupeResult {
  items: CanonicalItem[];
  clusterSize: Map<string, number>;
}

export function dedupe(items: CanonicalItem[]): DedupeResult {
  const byId = new Map<string, CanonicalItem>();
  const clusterSize = new Map<string, number>();
  for (const it of items) {
    if (byId.has(it.id)) {
      clusterSize.set(it.id, (clusterSize.get(it.id) ?? 1) + 1);
    } else {
      byId.set(it.id, it);
    }
  }
  const seenUrl = new Map<string, CanonicalItem>();
  const seenTitle = new Map<string, CanonicalItem>();
  const kept: CanonicalItem[] = [];
  const canonicalKey = (it: CanonicalItem) => it.canonicalUrl || it.url;

  for (const it of byId.values()) {
    // nf: ids are already unique events — identity dedupe done above.
    const url = canonicalKey(it);
    const title = normalizeTitle(it.title);
    const dupe = (url && seenUrl.get(url)) || (title && seenTitle.get(title));
    if (dupe) {
      clusterSize.set(dupe.id, (clusterSize.get(dupe.id) ?? 1) + 1);
      continue;
    }
    if (url) seenUrl.set(url, it);
    if (title) seenTitle.set(title, it);
    clusterSize.set(it.id, clusterSize.get(it.id) ?? 1);
    kept.push(it);
  }
  return { items: kept, clusterSize };
}

export interface TopicWeights {
  keywords: string[];
  entities: string[];
  weight: number;
}

export interface SelectInput {
  lane: LaneId;
  items: CanonicalItem[];
  clusterSize: Map<string, number>;
  topics: Record<string, TopicWeights>;
  negatives: string[];
  budget: [number, number];
  nowMs: number;
}

export interface Scored {
  item: CanonicalItem;
  score: number;
  reasons: string[];
}

// Rules-only selection: recency decay + tier weight + topic-weighted
// keyword/entity hits + engagement percentile + cluster-size bonus,
// minus negative-filter penalty.
export function scoreItems(input: SelectInput): Scored[] {
  const { lane, items, clusterSize, topics, negatives, nowMs } = input;
  const topicKey = lane.startsWith("reddit-") ? undefined : lane;
  const topic = topicKey ? topics[topicKey] : undefined;

  const engVals = items.map((it) => it.engagement?.score ?? 0);
  const engMax = Math.max(1, ...engVals);

  return items.map((item) => {
    const reasons: string[] = [];
    let score = 0;
    const ageHrs = Math.max(0, (nowMs - Date.parse(item.publishedAt)) / 3600_000);
    const recency = Math.max(0, 1 - ageHrs / 48);
    score += recency;
    const tierW = item.tier === 1 ? 0.3 : item.tier === 2 ? 0.15 : 0;
    score += tierW;

    const hay = `${item.title} ${item.dek ?? ""}`.toLowerCase();
    if (topic) {
      let hits = 0;
      for (const kw of [...topic.keywords, ...topic.entities]) {
        if (kw && hay.includes(kw.toLowerCase())) {
          hits++;
          if (reasons.length < 2) reasons.push(`matches ${kw}`);
        }
      }
      score += Math.min(0.3, hits * 0.1) * (topic.weight ?? 1);
    }

    const eng = (item.engagement?.score ?? 0) / engMax;
    score += eng * 0.2;
    if (eng > 0.5) reasons.push("high engagement");

    const size = clusterSize.get(item.id) ?? 1;
    const clusterBonus = Math.min(0.2, (size - 1) * 0.1);
    score += clusterBonus;
    if (size > 1) reasons.push(`covered by ${size} outlets`);

    for (const neg of negatives) {
      if (neg && hay.includes(neg.toLowerCase())) {
        score -= 1.0;
        reasons.push(`negative filter: ${neg}`);
      }
    }
    return { item, score, reasons };
  });
}

export interface Selection {
  picked: boolean;
  ruleScore: number;
  reason: string;
}

export function selectTop(
  scored: Scored[],
  budget: [number, number]
): Map<string, Selection> {
  const [, max] = budget;
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const out = new Map<string, Selection>();
  ranked.forEach((s, i) => {
    const picked = i < max;
    out.set(s.item.id, {
      picked,
      ruleScore: Math.round(s.score * 100) / 100,
      reason: picked
        ? s.reasons.slice(0, 2).join("; ") || "top rule score"
        : s.reasons.find((r) => r.startsWith("negative filter")) ??
          `relevance ${Math.round(s.score * 100) / 100} below top ${max}`,
    });
  });
  return out;
}
