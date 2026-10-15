// daup-duidelik — Cloudflare Worker (P5: AI co-author route).
//
// DAUP-PORT-PLAN §6 / STACK §4: the app's aiClient needs a model transport. On daup
// that transport is THIS Worker route — the model key lives as a Cloudflare SECRET
// (env.AI_API_KEY), NEVER in the client bundle. The browser calls POST /ai/draft and
// POST /ai/score; the Worker assembles the prompt from content's contract
// (docs/content/ai-coauthor-prompts.md), calls the model, and returns parsed JSON.
//
// Everything that is NOT /ai/* falls through to the static SPA assets (the Vite dist/
// served via the ASSETS binding, with SPA fallback) — so one Worker serves both the
// app and its AI route.
//
// Non-negotiables enforced here (ai-coauthor-prompts.md §0 + STACK §4):
//   • The key never reaches the client. The Worker is the only holder.
//   • The AI returns ONLY content or scores — never stage/status/Signature. This
//     route cannot touch the store; it only relays model output back to aiClient,
//     which already refuses to write governance fields.
//   • Fail soft: any upstream error → 502 with a short JSON error; the client's
//     aiClient treats a non-2xx as "AI unavailable" and degrades (offline co-author,
//     deterministic rigour stands alone). The app is NEVER blocked on AI.
//   • The prompt WORDING is content's (ai-coauthor-prompts.md). This file carries the
//     §0 preamble + the §1–§4 user-message templates verbatim in intent; it does not
//     invent gate criteria — it passes the live values and asks for schema-shaped JSON.

export interface Env {
  // Cloudflare secret — set with: wrangler secret put AI_API_KEY
  AI_API_KEY?: string;
  // Optional overrides (plain vars, safe to commit as wrangler.json vars):
  AI_API_URL?: string; // default: OpenAI-compatible chat completions endpoint
  AI_MODEL?: string; // default below
  // Static assets binding (wrangler.json assets.binding = "ASSETS")
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const DEFAULT_AI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_AI_MODEL = "gpt-4o-mini";
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 128 * 1024; // reject oversized payloads early

// ── content's shared system preamble (ai-coauthor-prompts.md §0) ───────────────────
const SYSTEM_PREAMBLE = `You are the duidelik co-author. duidelik is a producer-side workbench where Business
and Functional Analysts shape data products through a governed lifecycle
(one-liner -> BRD -> FSD -> QRG -> Live). Your job is to DRAFT fast and clearly; a human
always edits and signs. Clarity is the product: never pad, never invent facts, never
hide uncertainty. When you don't know a value, leave the field empty or add it to
openQuestions -- do NOT fabricate a plausible-looking value, because the rigour gate
is designed to catch exactly that and a fabricated value wastes the author's time.

You always reply with a SINGLE JSON object and nothing else -- no prose, no markdown
fences, no commentary. The JSON must match the schema you are given exactly: same
field names, same shape. Omit a field only if the schema marks it optional and you
have nothing real to put there.`;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), { status, headers: JSON_HEADERS });
}

/** Build the user-message template for a draft/score call from content's contract. */
function buildUserMessage(kind: string, docType: string, payload: Record<string, unknown>): string {
  if (kind === "draft") {
    // ai-coauthor-prompts.md §1-§3: draft a BRD/FSD/QRG. The exact per-docType rules
    // live in content's doc; here we pass the live values + the schema expectation and
    // rely on the §0 preamble + the schema echo to shape the output. The caller
    // (aiClient) validates the returned JSON against the docs/templates schema.
    return [
      `Draft the "content" object for a ${docType} in the duidelik lifecycle.`,
      `Return ONLY a single JSON object matching the ${docType} content schema`,
      `(docs/templates/${docType}-template.md §2). Do not wrap it in prose or fences.`,
      ``,
      `INPUTS (JSON):`,
      JSON.stringify(payload, null, 2),
      ``,
      `Follow the brd-v1/fsd-v1 rigour rules: a concrete decision (named actor + action),`,
      `numeric metric targets, specific out-of-scope items, named data sources, every`,
      `entity with an explicit grain, and traceable requirements. Put genuine unknowns in`,
      `openQuestions rather than fabricating values.`,
    ].join("\n");
  }
  // kind === "score" — ai-coauthor-prompts.md §4. The deterministic score is already
  // computed client-side and passed in payload.items as codeScore; the model may only
  // CONFIRM or make STRICTER and write a one-line reason. The stricter-wins clamp is
  // enforced by the CLIENT (rigour.ts) — we only relay the model's opinion.
  return [
    `You are scoring a ${docType} against the FIXED duidelik rigour checklist. For each`,
    `item you are given its key, the deterministic score the code already assigned, and`,
    `the content it reads. You MAY keep the score or make it STRICTER (GREEN->AMBER,`,
    `AMBER->RED). You may NEVER make it looser; a looser score is discarded by the system.`,
    `Write a one-line reason (<=140 chars) telling the author exactly what to fix.`,
    ``,
    `ITEMS (JSON):`,
    JSON.stringify(payload, null, 2),
    ``,
    `Return ONLY a JSON object { "scores": [ { "key": "...", "score": "GREEN|AMBER|RED",`,
    `"reason": "..." } ] } with every given key present exactly once.`,
  ].join("\n");
}

/** Call the OpenAI-compatible chat endpoint and return the parsed model JSON. */
async function callModel(env: Env, system: string, user: string): Promise<unknown> {
  const url = env.AI_API_URL || DEFAULT_AI_API_URL;
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Do NOT echo the upstream body (it can carry key hints / rate-limit detail).
    throw new Error(`upstream ${res.status}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("empty model response");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("model did not return valid JSON");
  }
}

async function handleAi(kind: "draft" | "score", request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  if (!env.AI_API_KEY) {
    // No secret configured → behave exactly like "AI unavailable" so the client degrades.
    return jsonError(503, "AI co-author not configured");
  }
  // Guard body size before reading.
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY_BYTES) return jsonError(413, "payload too large");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }
  if (!body || typeof body !== "object") return jsonError(400, "body must be a JSON object");
  const { docType, payload } = body as { docType?: unknown; payload?: unknown };
  if (typeof docType !== "string" || !/^(BRD|FSD|QRG)$/.test(docType)) {
    return jsonError(400, "docType must be BRD|FSD|QRG");
  }
  const safePayload = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  try {
    const user = buildUserMessage(kind, docType, safePayload);
    const result = await callModel(env, SYSTEM_PREAMBLE, user);
    // For score, the client expects an array; unwrap { scores: [...] } if present.
    if (kind === "score") {
      const rows = (result as { scores?: unknown })?.scores ?? result;
      return new Response(JSON.stringify(rows), { status: 200, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ai call failed";
    // 502: the client's aiClient treats any non-2xx as unavailable and degrades.
    return jsonError(502, msg);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ai/draft") return handleAi("draft", request, env);
    if (url.pathname === "/ai/score") return handleAi("score", request, env);
    // Everything else → static SPA assets (with the SPA fallback configured in wrangler.json).
    return env.ASSETS.fetch(request);
  },
};
