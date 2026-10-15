// duidelik — rigour scoring engine (RIGOUR-AND-SIGNING.md §2, two-layer, stricter-wins)
//
// runRigour(doc, ctx, aiClient?) produces a fresh set of RigourCheck rows for a
// document, keyed by the frozen checklist key. The contract:
//
//   LAYER 1 — deterministic (code). Runs FIRST, always, with no AI. This is the
//             FLOOR: an empty required field is RED regardless of anything the model
//             later says. Predicates come from the content spec (checklists.ts).
//
//   LAYER 2 — AI refinement (optional). aiClient.score may CONFIRM or make STRICTER
//             (GREEN→AMBER, AMBER→RED) and write the one-line reason. It can NEVER
//             loosen: finalScore = stricter(codeScore, aiScore). A looser AI score
//             is DISCARDED here (not trusted to the model). On AI failure/absence,
//             the deterministic scores stand with a generic reason.
//
// Re-scoring regenerates all rows by key; an existing AMBER overrideNote survives
// ONLY if the item is still AMBER with the same key (RIGOUR §2). GREEN/RED clears it.
//
// Ported verbatim (logic) from app/src/rigour.js; JS→TS typing only.

import { Score } from "./enums";
import type { ScoreValue } from "./enums";
import { getChecklistSpec, CHECKLIST_KEYS } from "./checklists";
import type { ScoreContext } from "./checklists";
import type { AiClient } from "./aiClient";
import type { DuidelikDocument, RigourCheck } from "../types";

const SEVERITY: Record<ScoreValue, number> = {
  [Score.GREEN]: 0,
  [Score.AMBER]: 1,
  [Score.RED]: 2,
};

/** The stricter (higher-severity) of two scores. */
export function stricter(a: ScoreValue, b: ScoreValue): ScoreValue {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export interface RunRigourOpts {
  aiClient?: AiClient | null;
  priorChecks?: RigourCheck[];
  genId?: () => string | undefined;
}

export interface RunRigourResult {
  checks: RigourCheck[];
  rollup: ScoreValue;
  deterministicOnly: boolean;
}

type CodeScore = { key: string; score: ScoreValue; reason: string };

/**
 * Run rigour over a document. `ctx` is the scoring context (content, product,
 * resolveUser, placementIntact, signedBrdKeys, now) assembled by the caller.
 */
export async function runRigour(
  doc: Pick<DuidelikDocument, "id" | "type" | "content">,
  ctx: ScoreContext,
  opts: RunRigourOpts = {},
): Promise<RunRigourResult> {
  const spec = getChecklistSpec();
  const keyDefs = CHECKLIST_KEYS[doc.type] || [];
  const nowIso =
    (ctx.now instanceof Date ? ctx.now : new Date()).toISOString();
  const genId = opts.genId || (() => undefined);
  const priorByKey = indexBy(opts.priorChecks || [], "key");

  // ── LAYER 1: deterministic floor ──────────────────────────────────────────
  const codeScores: CodeScore[] = keyDefs.map(({ key }) => {
    const def = spec[key];
    if (!def || typeof def.deterministic !== "function") {
      // Unknown key (content spec incomplete): fail safe to RED, never silently pass.
      return { key, score: Score.RED, reason: `No deterministic rule for ${key}.` };
    }
    const r = def.deterministic(ctx) || ({} as Partial<CodeScore>);
    return { key, score: r.score || Score.RED, reason: r.reason || "" };
  });

  // ── LAYER 2: AI refinement (clamped stricter-wins) ────────────────────────
  let deterministicOnly = true;
  let aiByKey: Record<string, { key: string; score: ScoreValue; reason: string }> = {};
  const ai = opts.aiClient;
  if (ai && ai.isAvailable && ai.isAvailable()) {
    try {
      const aiScores = await ai.score(doc.type, doc, codeScores);
      aiByKey = indexBy(Array.isArray(aiScores) ? aiScores : [], "key");
      deterministicOnly = false;
    } catch {
      // Any failure/timeout: keep the deterministic floor (RIGOUR §2, STACK §4).
      aiByKey = {};
      deterministicOnly = true;
    }
  }

  // ── Merge: stricter(code, ai); AI reason kept only when it did not loosen ─
  const checks: RigourCheck[] = codeScores.map((code) => {
    const aiRow = aiByKey[code.key];
    let finalScore = code.score;
    let reason = deterministicOnly
      ? code.reason || "Scored by deterministic check; AI unavailable."
      : code.reason;

    if (aiRow && isScore(aiRow.score)) {
      const clamped = stricter(code.score, aiRow.score); // AI may only tighten
      finalScore = clamped;
      // Keep the AI's human-facing reason when it is valid and it did not try to loosen.
      if (aiRow.reason && SEVERITY[aiRow.score] >= SEVERITY[code.score]) {
        reason = String(aiRow.reason);
      }
    }
    if (!reason) reason = "Scored by deterministic check.";

    // Override-note preservation: survives only if still AMBER with same key.
    const prior = priorByKey[code.key];
    const keepOverride =
      prior && finalScore === Score.AMBER && prior.score === Score.AMBER && prior.overrideNote;

    return {
      id: (prior && prior.id) || genId(),
      documentId: doc.id,
      key: code.key,
      score: finalScore,
      reason,
      overrideNote: keepOverride ? prior.overrideNote : null,
      overriddenById: keepOverride ? prior.overriddenById : null,
      overriddenAt: keepOverride ? prior.overriddenAt : null,
      scoredAt: nowIso,
    };
  });

  return { checks, rollup: rollup(checks), deterministicOnly };
}

/** Gate roll-up: worst item wins (RIGOUR §4 / checklist-wording §4). */
export function rollup(checks: Pick<RigourCheck, "score">[]): ScoreValue {
  let worst: ScoreValue = Score.GREEN;
  for (const c of checks) worst = stricter(worst, c.score);
  return worst;
}

/** { pass, amber, red } counts for the .rigour-tally (DESIGN-SYSTEM §6.11). */
export function tally(checks: Pick<RigourCheck, "score">[]): { pass: number; amber: number; red: number } {
  const t = { pass: 0, amber: 0, red: 0 };
  for (const c of checks) {
    if (c.score === Score.GREEN) t.pass++;
    else if (c.score === Score.AMBER) t.amber++;
    else if (c.score === Score.RED) t.red++;
  }
  return t;
}

/**
 * Apply a human override note to an AMBER item (RIGOUR §4). Returns the updated
 * check or throws if the item is not AMBER / the note is empty. The AI never calls
 * this — it is a human action.
 */
export function applyOverride(
  check: RigourCheck,
  note: string,
  actingUserId: string | null,
  now: Date = new Date(),
): RigourCheck {
  if (check.score !== Score.AMBER) {
    throw new Error(`Override only applies to AMBER items (got ${check.score}).`);
  }
  const trimmed = String(note ?? "").trim();
  if (!trimmed) throw new Error("Override note must be non-empty.");
  return {
    ...check,
    overrideNote: trimmed,
    overriddenById: actingUserId,
    overriddenAt: now.toISOString(),
  };
}

function isScore(s: unknown): s is ScoreValue {
  return s === Score.GREEN || s === Score.AMBER || s === Score.RED;
}

function indexBy<T extends Record<string, any>>(arr: T[], key: string): Record<string, T> {
  const m: Record<string, T> = {};
  for (const x of arr) if (x && x[key] != null) m[x[key]] = x;
  return m;
}
