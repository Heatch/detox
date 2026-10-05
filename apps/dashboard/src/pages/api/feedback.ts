import type { APIRoute } from "astro";
import { openDb } from "@detox/core";

function root(): string {
  return process.env.DETOX_ROOT ?? process.cwd();
}

// POST /api/feedback { run_id, item_id, value } → one row in `feedback`.
// Phase 4 mechanism for prompt/selection tuning: day-granularity judgments
// (digest thumbs today, per-item thumbs later). Accepts +1/-1 only.
export const POST: APIRoute = async ({ request }) => {
  let body: { run_id?: unknown; item_id?: unknown; value?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (typeof body.run_id !== "number" || typeof body.item_id !== "string" || (body.value !== 1 && body.value !== -1)) {
    return Response.json({ ok: false, error: "need {run_id: number, item_id: string, value: +1|-1}" }, { status: 400 });
  }
  const db = openDb(root() + "/data");
  try {
    db.prepare("INSERT INTO feedback (run_id, item_id, value) VALUES (?, ?, ?)").run(
      body.run_id,
      body.item_id,
      body.value
    );
    return Response.json({ ok: true });
  } finally {
    db.close();
  }
};
