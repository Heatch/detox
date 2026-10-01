import type { CollectContext, RawItem } from "@detox/core";
import { AdapterError, fetchJson, fetchText } from "../http.js";
import { FileCache } from "../cache.js";

// Official Reddit API, app-only OAuth (experiment 005). Retrieval only —
// NO LLM involvement with Reddit, ever (user decision 2026-10-01): full
// post text (selftext) and top comments in full render raw.
export const ID = "reddit.listings";

interface RedditConfig {
  subreddits: string[];
  top_n: number;
  top_comments_n: number;
  time_window: string;
  exclude_title_patterns: string[];
}

interface RedditEnv {
  clientId: string;
  clientSecret: string;
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH = "https://oauth.reddit.com";

async function getToken(env: RedditEnv, cache: FileCache): Promise<string> {
  const cached = cache.get("reddit:token");
  if (cached && Date.parse((cached as { body: { exp: string } }).body.exp) > Date.now() + 60_000) {
    return (cached as { body: { access: string } }).body.access;
  }
  const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64");
  const body = await fetchText(ID, TOKEN_URL, { minGapMs: 1000 }, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const tok = JSON.parse(body) as { access_token: string; expires_in: number };
  if (!tok.access_token) throw new AdapterError(ID, TOKEN_URL, "no access_token in response");
  const access = tok.access_token;
  cache.set("reddit:token", {
    body: {
      access,
      exp: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    },
    at: new Date().toISOString(),
  });
  return access;
}

export async function collectReddit(
  ctx: CollectContext,
  cfg: RedditConfig,
  env: RedditEnv,
  dataDir: string
): Promise<RawItem[]> {
  const at = new Date().toISOString();
  const cache = new FileCache(dataDir);
  const token = await getToken(env, cache);
  const auth = { Authorization: `Bearer ${token}` };
  const out: RawItem[] = [];

  for (const sub of cfg.subreddits) {
    const url = `${OAUTH}/r/${sub}/top?t=${cfg.time_window}&limit=${cfg.top_n}&raw_json=1`;
    const listing = (await fetchJson(ID, url, { minGapMs: 1000, headers: auth })) as {
      data?: { children?: { kind: string; data: Record<string, unknown> }[] };
    };
    const posts = (listing.data?.children ?? []).filter((c) => c.kind === "t3");
    for (const post of posts) {
      const d = post.data as Record<string, unknown>;
      const title = String(d.title ?? "");
      if (cfg.exclude_title_patterns.some((p) => title.toLowerCase().includes(p.toLowerCase()))) {
        continue;
      }
      const id = String(d.id ?? "");
      // Top comments, kind off the listing WRAPPER (experiment 005 — the bug
      // that silently drops everything if read from inside data).
      let comments: unknown[] = [];
      if (cfg.top_comments_n > 0 && id) {
        const curl = `${OAUTH}/comments/${id}?sort=top&depth=1&limit=${cfg.top_comments_n}&raw_json=1`;
        const cbody = (await fetchJson(ID, curl, { minGapMs: 600, headers: auth })) as unknown[];
        const kids = (cbody?.[1] as { data?: { children?: { kind: string; data: unknown }[] } })
          ?.data?.children ?? [];
        comments = kids.filter((c) => c.kind === "t1").map((c) => c.data);
      }
      out.push({
        adapter: ID,
        fetchedAt: at,
        payload: { subreddit: sub, post: d, comments },
      });
    }
    ctx.log(`${ID} r/${sub}: ${out.length} posts so far`);
  }
  return out;
}
