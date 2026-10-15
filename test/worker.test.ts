// daup-duidelik — P5 Worker route tests. Exercises worker/index.ts fetch handler with
// a mock env + mocked upstream fetch. Proves: /ai requires POST + a key, validates
// docType, relays a successful model call, fails soft on upstream error, and falls
// through to static ASSETS for non-/ai paths. No wrangler, no real key.

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker/index";

type Env = Parameters<typeof worker.fetch>[1];

function makeEnv(over: Partial<Env> = {}): Env {
  const assets = { fetch: vi.fn(async () => new Response("STATIC", { status: 200 })) };
  return { AI_API_KEY: "sk-test-key", ASSETS: assets, ...over } as Env;
}

function aiReq(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://duidelik.daup.co.za${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("P5 Worker /ai route", () => {
  it("falls through non-/ai paths to static ASSETS", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://duidelik.daup.co.za/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("STATIC");
    expect((env.ASSETS.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("rejects a GET on /ai/draft (405)", async () => {
    const res = await worker.fetch(aiReq("/ai/draft", null, "GET"), makeEnv());
    expect(res.status).toBe(405);
  });

  it("returns 503 (fails soft) when no AI_API_KEY is set", async () => {
    const env = makeEnv({ AI_API_KEY: undefined });
    const res = await worker.fetch(aiReq("/ai/draft", { docType: "BRD", payload: {} }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("rejects a bad docType (400)", async () => {
    const res = await worker.fetch(aiReq("/ai/draft", { docType: "WAT", payload: {} }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("relays a successful draft model call as parsed JSON", async () => {
    const modelJson = { decision: "Planners decide X instead of Y", outOfScope: ["promos"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelJson) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await worker.fetch(aiReq("/ai/draft", { docType: "BRD", payload: { product: {} } }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(modelJson);
  });

  it("unwraps { scores: [...] } for a score call", async () => {
    const scores = [{ key: "brd.decision_stated", score: "AMBER", reason: "vague" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scores }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await worker.fetch(aiReq("/ai/score", { docType: "BRD", payload: { items: [] } }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(scores);
  });

  it("fails soft (502) when the upstream model errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const res = await worker.fetch(aiReq("/ai/draft", { docType: "FSD", payload: {} }), makeEnv());
    expect(res.status).toBe(502);
    // must NOT echo upstream body (could carry key/limit detail)
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("rate limited");
  });

  it("fails soft (502) when the model returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await worker.fetch(aiReq("/ai/draft", { docType: "BRD", payload: {} }), makeEnv());
    expect(res.status).toBe(502);
  });
});
