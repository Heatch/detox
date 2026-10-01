import type { CollectContext, LaneId, RawItem, SourceAdapter } from "@detox/core";

// Phase 0 stub: emits a few fake RawItems per lane so the pipeline stages
// have something shaped like the real thing. Real adapters (newsflash,
// reddit, weather ×3, ESPN, TMDB, …) arrive in Phase 1+ and implement the
// same interface — one file per candidate source.
export class StubAdapter implements SourceAdapter {
  id = "stub.fake";
  lanes: LaneId[] = ["tech", "science", "weather"];

  async collect(ctx: CollectContext): Promise<RawItem[]> {
    const at = new Date().toISOString();
    ctx.log(`stub adapter collecting window ${ctx.fromIso}..${ctx.toIso}`);
    return (["tech", "science", "weather"] as const).flatMap((lane, li) =>
      [0, 1, 2].map((i) => ({
        adapter: this.id,
        fetchedAt: at,
        payload: {
          lane,
          title: `Stub ${lane} headline ${i + 1}`,
          url: `https://example.test/${lane}/${i + 1}`,
          outlet: "Stub Gazette",
          publishedAt: at,
          outletTier: ((li + i) % 3) + 1,
        },
      }))
    );
  }
}

export const adapters: SourceAdapter[] = [new StubAdapter()];
