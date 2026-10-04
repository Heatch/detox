import { describe, expect, it, vi } from "vitest";
import { BackboardProvider, GoogleAIStudioProvider, LlmHttpError } from "../src/providers.js";
import { buildTasteProfile, scoreTasteRules, stageCacheKey, type TasteCandidate } from "../src/stages.js";
import { parseJsonStrict } from "../src/stages.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GoogleAIStudioProvider", () => {
  it("parses OpenAI-shim usage (prompt_tokens style)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: '{"text":"hi"}' } }], usage: { prompt_tokens: 11, completion_tokens: 5 } })
    );
    const p = new GoogleAIStudioProvider("https://x.test", "K", fetchFn as typeof fetch);
    const r = await p.complete({ model: "m", userContent: "hi", json: true });
    expect(r.text).toBe('{"text":"hi"}');
    expect(r.tokensIn).toBe(11);
    expect(r.tokensOut).toBe(5);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer K");
    expect(init.body as string).toContain("json_object");
  });

  it("throws retryable LlmHttpError on 503", async () => {
    const fetchFn = vi.fn(async () => new Response("overloaded", { status: 503 }));
    const p = new GoogleAIStudioProvider("https://x.test", "K", fetchFn as typeof fetch);
    const err = await p.complete({ model: "m", userContent: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).retryable).toBe(true);
  });

  it("throws non-retryable LlmHttpError on 400", async () => {
    const fetchFn = vi.fn(async () => new Response("bad", { status: 400 }));
    const p = new GoogleAIStudioProvider("https://x.test", "K", fetchFn as typeof fetch);
    const err = await p.complete({ model: "m", userContent: "hi" }).catch((e) => e);
    expect((err as LlmHttpError).retryable).toBe(false);
  });
});

describe("BackboardProvider", () => {
  it("posts threads/messages with X-API-Key and reads token fields", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ content: '{"ok":1}', input_tokens: 20, output_tokens: 4 }));
    const p = new BackboardProvider("https://y.test/api", "K", "openai", fetchFn as typeof fetch);
    const r = await p.complete({ model: "gpt-5.6-luna", userContent: "hi", json: true });
    expect(r.text).toBe('{"ok":1}');
    expect(r.tokensIn).toBe(20);
    expect(r.tokensOut).toBe(4);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://y.test/api/threads/messages");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model_name: "gpt-5.6-luna", llm_provider: "openai", json_output: true, memory: "off" });
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("K");
  });

  it("treats null token counts as 0", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ content: "hi", input_tokens: null, output_tokens: null }));
    const p = new BackboardProvider("https://y.test/api", "K", "openai", fetchFn as typeof fetch);
    const r = await p.complete({ model: "m", userContent: "hi" });
    expect(r.tokensIn).toBe(0);
    expect(r.tokensOut).toBe(0);
  });
});

describe("scoreTasteRules", () => {
  const loved: TasteCandidate[] = [
    { id: "a", title: "The Boys", tags: ["loved"], notes: "amazing and funny show" },
    { id: "b", title: "XO, Kitty", tags: ["loved", "guilty-pleasure", "slop-but-loved"], notes: "high quality slop" },
  ];
  const disliked: TasteCandidate[] = [
    { id: "c", title: "House of the Dragon", tags: ["dropped", "fantasy-aversion"], notes: "fantasy historical not for me" },
  ];
  const profile = { loved, disliked, excludedIds: ["x"] };

  it("ranks loved-like candidates above disliked-like ones", () => {
    const scores = scoreTasteRules(profile, [
      { id: "n1", title: "Gen V", tags: ["liked"], notes: "funny show, pretty good" },
      { id: "n2", title: "Dark Fantasy Chronicles", tags: ["dropped"], notes: "fantasy historical epic" },
    ]);
    const byId = new Map(scores.map((s) => [s.id, s]));
    expect(byId.get("n1")!.confidence).toBeGreaterThan(byId.get("n2")!.confidence);
    expect(byId.get("n1")!.reason.length).toBeGreaterThan(0);
  });

  it("caps excluded ids and supports leave-one-out", () => {
    const scores = scoreTasteRules(profile, [{ id: "x", title: "Anime Show", tags: ["anime"] }]);
    expect(scores[0].confidence).toBe(0.05);
    const loo = scoreTasteRules(profile, [{ id: "a", title: "The Boys", tags: ["loved"] }], "a");
    expect(loo[0].confidence).toBeLessThan(0.95);
  });

  it("builds a profile from gold rows", () => {
    const p = buildTasteProfile([
      { item_id: "a", title: "A", watch: "yes" },
      { item_id: "b", title: "B", watch: "no" },
      { item_id: "c", title: "C", watch: "no", recommendable: false },
    ]);
    expect(p.loved.map((x) => x.id)).toEqual(["a"]);
    expect(p.disliked.map((x) => x.id)).toEqual(["b", "c"]);
    expect(p.excludedIds).toEqual(["c"]);
  });
});

describe("parseJsonStrict", () => {
  it("strips code fences", () => {
    expect(parseJsonStrict('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonStrict('{"a":1}')).toEqual({ a: 1 });
  });
  it("rejects prose with a snippet", () => {
    expect(() => parseJsonStrict("hello world")).toThrow(/non-JSON/);
  });
});

describe("stageCacheKey", () => {
  it("is stable and input-sensitive", () => {
    expect(stageCacheKey("v", { b: 1, a: 2 })).toBe(stageCacheKey("v", { a: 2, b: 1 }));
    expect(stageCacheKey("v", { a: 1 })).not.toBe(stageCacheKey("v", { a: 2 }));
    expect(stageCacheKey("v1", { a: 1 })).not.toBe(stageCacheKey("v2", { a: 1 }));
  });
});
