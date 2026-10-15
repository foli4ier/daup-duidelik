// duidelik — aiClient seam (STACK.md §4, LOCKED Q1)
//
// THE SINGLE AI TOUCHPOINT. No model call lives anywhere else in the app. Two
// methods, both async, both allowed to fail:
//
//   draft(docType, product, context)  → structured section content (co-author)
//   score(docType, document, items)   → [{ key, score, reason }] (rigour refinement)
//
// v1 is a DIRECT model call from the artifact (STACK §4). But a live surface is not
// an always-available one: the model can be slow, rate-limited, or error. Every
// caller MUST treat a rejection/timeout as "AI unavailable" and degrade:
//   - co-author → manual editing (DESIGN-SYSTEM §6.10 .ai-bar--offline)
//   - rigour    → deterministic score stands alone (rigour.ts)
//
// RULES baked in here:
//   • NO embedded long-lived API key (STACK §4 / §6). The concrete transport is
//     injected (the runtime's model-call surface), not hard-coded. On daup this is
//     the Worker /ai/* route (DAUP-PORT-PLAN §6) — still just an injected transport.
//   • The AI NEVER writes stage/status/Signature and NEVER override notes
//     (ai-coauthor-prompts.md non-negotiables). This module only returns content or
//     scores; it cannot reach the store.
//   • Prompts come from content (docs/content/ai-coauthor-prompts.md) — this seam
//     carries the transport + the degradation contract, not the prompt wording.
//
// Ported verbatim from app/src/aiClient.js.

import type { DocTypeValue, ScoreValue } from "./enums";

export interface AiScoreRow {
  key: string;
  score: ScoreValue;
  reason: string;
}

export type AiTransport = (req: {
  kind: string;
  docType: DocTypeValue;
  payload: Record<string, unknown>;
}) => Promise<any>;

export interface AiClient {
  isAvailable: () => boolean;
  draft: (docType: DocTypeValue, product: unknown, context?: Record<string, unknown>) => Promise<any>;
  score: (docType: DocTypeValue, document: unknown, items?: unknown) => Promise<AiScoreRow[]>;
}

export interface CreateAiClientOpts {
  transport?: AiTransport | null;
  timeoutMs?: number;
}

class AiCallError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Create an aiClient. Omit `transport` → a NULL client that always reports
 * unavailable (the app runs fully; AI features show their offline state).
 */
export function createAiClient(opts: CreateAiClientOpts = {}): AiClient {
  const transport = opts.transport || null;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const available = () => transport != null;

  async function call(kind: string, docType: DocTypeValue, payload: Record<string, unknown>): Promise<any> {
    if (!transport) {
      throw new AiCallError("AI co-author unavailable", "AI_UNAVAILABLE");
    }
    return withTimeout(transport({ kind, docType, payload }), timeoutMs);
  }

  return {
    /** Is a model transport wired at all? UI uses this to pick the offline bar. */
    isAvailable: available,

    /**
     * Co-author draft. Returns a `content` object matching the docType's template
     * schema (docs/templates/*). Caller validates against the schema and lets the
     * human edit. Rejects with code AI_UNAVAILABLE / AI_TIMEOUT on failure.
     */
    async draft(docType, product, context = {}) {
      return call("draft", docType, { product, context });
    },

    /**
     * Rigour refinement. Given the per-key deterministic scores, the AI may CONFIRM
     * or make STRICTER (GREEN→AMBER) and write a one-line reason — it can NEVER
     * loosen (RIGOUR §2). The clamp is enforced by the CALLER (rigour.ts), not
     * trusted here. Returns [{key, score, reason}]. Rejects on failure; caller then
     * keeps the deterministic scores.
     */
    async score(docType, document, items) {
      return call("score", docType, { document, items });
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new AiCallError("AI call timed out", "AI_TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** The explicit null client — AI features render their offline state everywhere. */
export const NULL_AI_CLIENT = createAiClient();
