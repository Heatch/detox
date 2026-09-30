# 005 — Reddit: top posts per subreddit via the official API

Status: validated 2026-09-30 (app-only OAuth, top-by-score retrieval) | Revisit: 2027-01-01

## Question

Can the official Reddit API serve the Reddit lanes — top N posts by upvotes
per subreddit, with N and the subreddit list configurable in
`config/interests.yaml` — and what does the response give us for the lane's
display and rule scoring?

## Candidates

- **Official Reddit API (OAuth app, client-credentials / app-only)** — the
  planned path (plan §9.5). Credentials in `.env` as `REDDIT_CLIENT_ID` /
  `REDDIT_CLIENT_SECRET`.
- RSS (`.rss` endpoints) — keyless fallback; no scores, so unusable for
  "by upvotes".
- Unofficial `.json` endpoints — fragile fallback.

## Method

Live probe 2026-09-30 (`scripts/reddit_probe.py`, kept as tooling). The
script reads `subreddits`, `top_n`, `time_window`, and
`exclude_title_patterns` straight from `config/interests.yaml` — the probe
doubles as proof that config drives the query. Test config: top 5 by upvotes
from r/nba, r/torontoraptors, r/uwaterloo, window `day`.

Flow: `POST /api/v1/access_token` (Basic auth, `grant_type=client_credentials`)
→ `GET https://oauth.reddit.com/r/{sub}/top?t={window}&limit={n}&raw_json=1`.

## Result

**Works cleanly.** 3 requests per run; app-only token issued (24 h expiry,
scope `*`), each sub returned exactly N posts already sorted by score
descending.

Sample (2026-09-30, t=day):

- **r/nba** — 14,000 / 6,102 / 5,791 / 5,277 / 3,616 pts. League-wide
  stories (Barkley quote, LeBron helicopter, Kawhi/Boingo). Rich threads
  (900–2,400 comments).
- **r/torontoraptors** — 387 / 363 / 188 / 176 / 177 pts. Roster talk,
  Kawhi nostalgia, Barrett contract reporting (Michael Grange).
- **r/uwaterloo** — 69 / 46 / 43 / 40 / 39 pts. Campus chatter.

**Observed quirks (all handled in the probe):**

- **Vote fuzzing:** score changed between two calls seconds apart
  (13,996→14,000; 6,096→6,102). Don't treat scores as stable keys or cache
  them as exact; fine for ranking within one fetch.
- **`raw_json=1` required** or titles come back HTML-entity-encoded
  (`&#8217;` etc.).
- **Scores are not comparable across subs** (r/nba top ≈ 14k, r/uwaterloo
  top ≈ 69). Any score threshold must be per-subreddit, not global.
- **Flair is rich text with emoji** ("🍕🍕🍕 PIZZA PARTY!!!",
  "🖐🏾 KAWHI LEONARD 🖐") — useful as a filter dimension (e.g. r/torontoraptors
  "Meme" flair on one top-5 post) and a reminder that flair text needs
  UTF-8-safe handling end to end.
- Fields available for rule scoring/display beyond title: `score`,
  `num_comments`, `upvote_ratio` (0.89–0.99 observed), `link_flair_text`,
  `created_utc`, `permalink`, `over_18`, `stickied`.
- `exclude_title_patterns` from config matched none of today's top-5 (no
  game threads landed in the day's top), so the filter is cheap insurance
  rather than a daily necessity.

**Comment retrieval (added 2026-09-30, second pass):** top-level comments
per kept post via `GET /comments/{id}?sort=top&depth=1&limit={top_comments_n}&raw_json=1`,
count driven by `top_comments_n` in `interests.yaml` (3 in the test). 15
posts × 1 request each = 15 extra requests per run (19 total with listings
and auth) — trivial. Observed:

- **Top comments are the punchline, often outscoring the post.** "get bron
  off helicopters bruh" (10,626 pts) sits under a 5,784-pt post; uwaterloo's
  43-pt crush thread has a 61-pt comment. Sorting by comment score within a
  thread is exactly right for "what did Reddit think".
- **`sort=top&depth=1` returns top-level only** — good enough for one-liner
  input; nested context is deliberately skipped.
- **Comment scores go negative** (−4 seen) — clamp or label, don't assume
  non-negative in sorting or display.
- **`kind: t1` lives on the listing wrapper** (`{kind, data}`), not inside
  `data` — filter on the wrapper or everything silently disappears (the
  bug this run caught).
- Comment fields available: `body`, `score`, `author`, `permalink`,
  `depth`, `stickied`, `is_submitter`, `collapsed`.
- Comment volume varies wildly (5 to 2,416 per thread); with `limit=3`
  retrieval is constant-cost regardless.

## Decision

**Official Reddit API, app-only OAuth — validated and adopted.** Per run:
1 token exchange (cached 24 h) + 1 request per configured subreddit.
Retrieval spec, now in `config/interests.yaml` and `config/sources.yaml`:

```yaml
reddit:
  subreddits: [nba, torontoraptors, uwaterloo]   # exact subs, any number
  top_n: 5
  time_window: day                # day | week | month | all
  exclude_title_patterns: ["game thread", "post game thread", "daily discussion"]
```

Sort is Reddit's own `top` (= by score) with the configured window. Feed
`score`/`num_comments`/`upvote_ratio` into rule scoring; keep flair as a
filter dimension. Top comments (validated same day) come from
`/comments/{id}?sort=top&depth=1&limit={top_comments_n}` per kept post and
are the input for one-liner summaries — summarization itself remains the
open LLM question from plan §9.5; retrieval is settled.

## Costs and limits

- App-only OAuth: ~100 requests/min per client; 3–4 requests per run plus
  1 per kept post for its top comments (19 total observed for 3 subs × 5
  posts × 3 comments) is nothing. No user account authorization needed for
  public listings.
- Token caching: 24 h expiry — refresh when expired, don't re-auth per run.
- If comment-fetching later (for summary input): 1 extra request per thread
  kept (`/r/{sub}/comments/{id}`), still trivial.
- No LLM involvement in retrieval.

## Follow-ups

- [ ] Summarization experiment: do one-liners over title + top comments earn
      their LLM cost, or is the title enough for these lanes? (Retrieval is
      done — top comments validated 2026-09-30; this is now purely a
      "does the LLM step pay for itself" question. Links to the gold set in
      plan §8.)
- [ ] Per-subreddit score normalization if a combined "Reddit" lane view is
      ever wanted (raw scores drown out r/uwaterloo next to r/nba).
- [ ] Consider `t=week` for r/uwaterloo specifically — daily top churns
      through low-score chatter (its day-top is ~40–70 pts).
