import type { CanonicalItem, LaneId, RawItem } from "@detox/core";
import { canonicalItemId } from "@detox/core";

// Normalize: RawItem payloads → CanonicalItems. Canonical URLs strip tracking
// params; timestamps stay ISO (age strings are computed at snapshot time).

const TRACKING = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "gclsrc", "msclkid", "mc_cid", "mc_eid", "igshid",
  "snr",
]);

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function ageString(publishedIso: string, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - Date.parse(publishedIso)) / 60000));
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

interface NfEvent {
  id: number;
  canonical_title?: string;
  summary?: string | null;
  first_seen_at?: string;
  url?: string;
  sources?: ({ name?: string } | string)[];
  source_count?: number;
  confidence?: number;
}

function sourceNames(e: NfEvent): string[] {
  return (e.sources ?? []).map((s) => (typeof s === "string" ? s : (s.name ?? "unknown")));
}

function outletLabel(names: string[]): string {
  if (names.length === 0) return "Newsflash";
  if (names.length === 1) return names[0];
  return `${names[0]} and ${names.length - 1} other${names.length === 2 ? "" : "s"}`;
}

export function normalizeNewsflash(raw: RawItem, lane: LaneId, nowIso: string): CanonicalItem | null {
  const p = raw.payload as { lane?: string; event?: NfEvent };
  const e = p.event;
  if (!e || e.id == null) return null;
  const url = e.url ?? "";
  return {
    id: `nf:${e.id}`,
    lane,
    sourceId: "news.newsflash",
    url,
    canonicalUrl: url ? canonicalizeUrl(url) : "",
    title: e.canonical_title ?? "(untitled)",
    dek: e.summary ?? undefined,
    publishedAt: e.first_seen_at ?? nowIso,
    fetchedAt: raw.fetchedAt,
    outlet: outletLabel(sourceNames(e)),
    tier: 2,
    engagement: e.source_count ? { score: e.source_count } : undefined,
    rawRef: 0,
  };
}

interface RedditPost {
  id?: unknown;
  title?: unknown;
  selftext?: unknown;
  permalink?: unknown;
  created_utc?: unknown;
  score?: unknown;
  num_comments?: unknown;
  upvote_ratio?: unknown;
  link_flair_text?: unknown;
}

export function normalizeReddit(
  raw: RawItem,
  lane: LaneId,
  tier: number,
  nowIso: string
): CanonicalItem | null {
  const p = raw.payload as {
    subreddit?: string;
    post?: RedditPost;
    comments?: { author?: unknown; score?: unknown; body?: unknown }[];
  };
  const d = p.post;
  if (!d || !d.id) return null;
  const url = `https://reddit.com${String(d.permalink ?? "")}`;
  void tier;
  return {
    id: `rd:${String(d.id)}`,
    lane,
    sourceId: "reddit.listings",
    url,
    canonicalUrl: canonicalizeUrl(url),
    title: String(d.title ?? "(untitled)"),
    content: String(d.selftext ?? ""),
    publishedAt: d.created_utc
      ? new Date(Number(d.created_utc) * 1000).toISOString()
      : nowIso,
    fetchedAt: raw.fetchedAt,
    outlet: `r/${p.subreddit ?? "unknown"}`,
    tier: 2,
    engagement: {
      score: Number(d.score ?? 0),
      comments: Number(d.num_comments ?? 0),
    },
    rawRef: 0,
  };
}

export function normalizeAll(raw: RawItem[], nowIso: string): CanonicalItem[] {
  const out: CanonicalItem[] = [];
  for (const r of raw) {
    if (r.adapter === "news.newsflash") {
      const lane = ((r.payload as { lane?: string }).lane ?? "tech") as LaneId;
      const item = normalizeNewsflash(r, lane, nowIso);
      if (item) out.push(item);
    } else if (r.adapter === "reddit.listings") {
      const sub = String((r.payload as { subreddit?: string }).subreddit ?? "unknown");
      const item = normalizeReddit(r, `reddit-${sub}` as LaneId, 2, nowIso);
      if (item) out.push(item);
    }
  }
  return out;
}
