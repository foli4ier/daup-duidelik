// daup-duidelik — client AI transport (P5). The concrete model-call surface the
// aiClient seam (src/core/aiClient.ts) consumes. It POSTs the {kind, docType, payload}
// envelope to the Worker route (worker/index.ts): /ai/draft or /ai/score.
//
// This is the ONLY place the client knows an AI endpoint URL. No key here — the key is
// a Cloudflare secret held by the Worker (DAUP-PORT-PLAN §6). Any non-2xx or network
// error rejects, and aiClient turns that into "AI unavailable" → the app degrades
// (offline co-author, deterministic rigour). The app is never blocked on AI (STACK §4).

import type { AiTransport } from "../core/aiClient";

// Same-origin by default (the Worker serves both the app and /ai/*). Overridable for
// local dev against a separate Worker via VITE_AI_BASE_URL.
const AI_BASE = (import.meta.env.VITE_AI_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

/** The transport injected as window.duidelikModelCall. */
export const workerAiTransport: AiTransport = async ({ kind, docType, payload }) => {
  if (kind !== "draft" && kind !== "score") {
    throw new Error(`unknown ai kind: ${kind}`);
  }
  const res = await fetch(`${AI_BASE}/ai/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ docType, payload }),
    cache: "no-store",
  });
  if (!res.ok) {
    // Let aiClient treat this as unavailable; don't leak upstream detail.
    throw new Error(`ai route ${res.status}`);
  }
  return res.json();
};
