# Detox — local-first morning dashboard (all phases complete; tuning per feature from here)

## Run it

Double-click **`start-detox.bat`**. It checks the toolchain, installs
dependencies if `node_modules` is missing, builds the dashboard, starts the
daemon and opens http://127.0.0.1:4321. Ctrl+C stops it; running it again while
the server is up just reopens the browser.

By hand:

```powershell
pnpm install
pnpm build        # pnpm start only serves dist/, it does not build it
pnpm start        # serves http://127.0.0.1:4321, arms the 09:00 scheduler
```

Start at login (Windows Task Scheduler):

```powershell
schtasks /create /tn Detox /tr "powershell -NoProfile -Command cd C:\path\to\detox; pnpm build; pnpm start" /sc onlogon
```

## Where things live

- `config/` — interests, settings, sources, models (validated with zod at load).
  Untracked in git: your portfolio, taste profile, and thresholds live here,
  so back this directory up. Copy `.env.example` to `.env` for keys.
- `apps/dashboard` — Astro app (`http://127.0.0.1:4321`), style tokens in
  `src/styles/tokens.css` (transcribed from `docs/style-guide.md`).
- `apps/pipeline` — `runPipeline(trigger)` entry point, scheduler, real
  stages (collect → normalize → dedupe → select → digest/taste → assemble),
  plus `pnpm eval` (gold-set harness) and `pnpm weather:score` (forecast
  accuracy tracking).
- `packages/core` — types, zod schemas, SQLite access, config loader.
- `data/` — gitignored: `detox.db`, `snapshots/`, cache, Spotify tokens.
- `docs/experiments/` — one decision record per source family and phase
  milestone (001–018).
- `scripts/` — setup tooling, not pipeline code (`spotify_auth.py` for the
  one-time Spotify OAuth bootstrap).

## Refresh contract (§4 of the plan)

On open: refresh if the last successful run is older than 24 h. Scheduled:
09:00 America/Toronto if the daemon is up (skipped if a run succeeded in the
last 3 h). Manual: the Refresh button. All non-blocking — the cached snapshot
renders instantly and the status line settles when the new one lands.
