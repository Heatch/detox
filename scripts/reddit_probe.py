import json, re, time, urllib.request, urllib.parse, urllib.error, base64, sys

repo = r"C:\Users\hites\Documents\Projects\Active\Detox\master"

# --- read config from interests.yaml (minimal parse, no yaml dep) ---
text = open(repo + r"\config\interests.yaml", encoding="utf-8").read()
m = re.search(r"^reddit:\s*\n((?:\s{2,}\S.*\n)+)", text, re.M)
block = m.group(1)
subs = re.search(r"subreddits:\s*\[([^\]]+)\]", block).group(1)
subreddits = [s.strip() for s in subs.split(",")]
top_n = int(re.search(r"top_n:\s*(\d+)", block).group(1))
m_tc = re.search(r"top_comments_n:\s*(\d+)", block)
top_comments_n = int(m_tc.group(1)) if m_tc else 0
window = re.search(r"time_window:\s*(\w+)", block).group(1)
excl = re.search(r"exclude_title_patterns:\s*\[([^\]]+)\]", block)
excl_pats = [p.strip().strip('"\'') for p in excl.group(1).split(",")] if excl else []
print("config: subs=%s top_n=%d top_comments_n=%d window=%s exclude=%s" % (
    subreddits, top_n, top_comments_n, window, excl_pats))

# --- env ---
env = {}
for line in open(repo + r"\.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"')

# --- OAuth: client credentials (app-only) ---
creds = base64.b64encode((env["REDDIT_CLIENT_ID"] + ":" + env["REDDIT_CLIENT_SECRET"]).encode()).decode()
req = urllib.request.Request(
    "https://www.reddit.com/api/v1/access_token",
    data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
    headers={"Authorization": "Basic " + creds,
             "User-Agent": "DetoxDashboard/0.1 (personal morning dashboard)"})
with urllib.request.urlopen(req) as r:
    tok = json.load(r)
print("auth: token_type=%s expires_in=%ss scope=%s" % (tok.get("token_type"), tok.get("expires_in"), tok.get("scope")))
access = tok["access_token"]

# --- top N per subreddit ---
UA = {"Authorization": "Bearer " + access,
      "User-Agent": "DetoxDashboard/0.1 (personal morning dashboard)"}
for sub in subreddits:
    url = "https://oauth.reddit.com/r/%s/top?t=%s&limit=%d&raw_json=1" % (sub, window, top_n)
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        print("\n=== r/%s -> HTTP %d %s" % (sub, e.code, e.read().decode()[:150]))
        continue
    kids = body.get("data", {}).get("children", [])
    print("\n=== r/%s  (t=%s, top %d) -> %d returned ===" % (sub, window, top_n, len(kids)))
    for i, k in enumerate(kids, 1):
        d = k.get("data", {})
        title = d.get("title", "")
        skip = any(p.lower() in title.lower() for p in excl_pats)
        print("  %d. [score %-6d comments %-5d %s] %s" % (
            i, d.get("score", 0), d.get("num_comments", 0),
            "SKIP" if skip else "keep", title[:88]))
        print("     fl=%-18s ups_ratio=%s created=%s id=%s" % (
            str(d.get("link_flair_text"))[:18], d.get("upvote_ratio"),
            d.get("created_utc"), d.get("id")))
        if skip or not top_comments_n:
            continue
        curl = "https://oauth.reddit.com/comments/%s?sort=top&depth=1&limit=%d&raw_json=1" % (
            d.get("id"), top_comments_n)
        creq = urllib.request.Request(curl, headers=UA)
        try:
            with urllib.request.urlopen(creq) as r:
                cbody = json.load(r)
        except urllib.error.HTTPError as e:
            print("     [comments HTTP %d]" % e.code)
            continue
        listing = cbody[1].get("data", {}).get("children", []) if len(cbody) > 1 else []
        for c in listing:
            if c.get("kind") != "t1":
                continue
            cd = c.get("data", {})
            bodytxt = " ".join(str(cd.get("body", "")).split())
            print("     c[score %-5d %-14s] %s" % (
                cd.get("score", 0), str(cd.get("author", ""))[:14], bodytxt[:110]))
        time.sleep(0.6)   # stay well inside OAuth rate limits
print("\ndone.")
