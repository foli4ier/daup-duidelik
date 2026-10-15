// duidelik — GATE S signing (RIGOUR-AND-SIGNING.md §3–§5, LIFECYCLE §4)
//
// signDocument(...) is the ONE place a signature is created. It enforces GATE S:
//
//   1. doc.status == IN_RIGOUR                        else ERR_NOT_IN_RIGOUR
//   2. no RigourCheck.score == RED                    else ERR_RED_BLOCKS   (+items)
//   3. every AMBER check has a non-empty overrideNote  else ERR_AMBER_NEEDS_NOTE (+items)
//   4. signerRoleOK(doc.type, actingUser.role)        else ERR_ROLE
//        BRD → PRODUCT_OWNER only; FSD → any role.
//
// On pass: mint an IMMUTABLE Signature (checklistSnapshot + documentHash), set
// doc.status = SIGNED. Stage unlock is the state machine's job (lifecycle.ts calls
// maybeUnlockNextStage after this returns ok).
//
// Returns { ok:true, signature, document } or a GateError.toResult() {ok:false,...}.
// Pure w.r.t. the store: it mutates the passed doc's status and returns the new
// Signature; the caller persists. No side effects beyond the returned objects.
//
// Ported verbatim (logic) from app/src/signing.js; JS→TS typing only.

import { DocStatus, DocType, Role } from "./enums";
import type { DocTypeValue, RoleValue } from "./enums";
import { ERR, GateError } from "./errors";
import type { GateResult, GateErrorItem } from "./errors";
import { checklistVersionFor } from "./checklists";
import { Score } from "./enums";
import type {
  DuidelikDocument,
  RigourCheck,
  Signature,
  ActingUser,
  DocContent,
} from "../types";

export interface SignOpts {
  genId?: () => string | undefined;
  hash?: (content: DocContent) => string;
  now?: Date;
}

export interface SignSuccess {
  ok: true;
  signature: Signature;
  document: DuidelikDocument;
}

export type SignResult = SignSuccess | GateResult;

/** Role gate (RIGOUR §3). */
export function signerRoleOK(docType: DocTypeValue, role: RoleValue | undefined): boolean {
  if (docType === DocType.BRD) return role === Role.PRODUCT_OWNER;
  if (docType === DocType.FSD) return true; // any role signs off to build in v1
  return false; // QRG is not signed; it is published (lifecycle.ts)
}

/** Attempt to sign a document. */
export function signDocument(
  doc: DuidelikDocument,
  checks: RigourCheck[],
  actingUser: ActingUser,
  opts: SignOpts = {},
): SignResult {
  try {
    assertGateS(doc, checks, actingUser);
  } catch (e) {
    if (e instanceof GateError) return e.toResult();
    throw e;
  }

  const now = opts.now || new Date();
  const hash = opts.hash || defaultHash;
  const signature: Signature = Object.freeze({
    id: opts.genId ? opts.genId() : undefined,
    documentId: doc.id,
    signedById: actingUser.id,
    signedByRole: actingUser.role, // snapshotted at sign time
    signedAt: now.toISOString(),
    checklistVersion: doc.checklistVersion || checklistVersionFor(doc.type),
    // frozen copy of every check (key/score/reason/overrideNote) — immutable
    checklistSnapshot: Object.freeze(
      checks.map((c) =>
        Object.freeze({
          key: c.key,
          score: c.score,
          reason: c.reason,
          overrideNote: c.overrideNote ?? null,
          overriddenById: c.overriddenById ?? null,
        }),
      ),
    ),
    documentHash: hash(doc.content), // proves exactly what was signed
  });

  const document: DuidelikDocument = { ...doc, status: DocStatus.SIGNED };
  return { ok: true, signature, document };
}

/** Throws a GateError if GATE S does not pass; returns silently if it does. */
export function assertGateS(
  doc: DuidelikDocument,
  checks: RigourCheck[],
  actingUser: ActingUser | undefined,
): void {
  // 1. rigour must have run
  if (doc.status !== DocStatus.IN_RIGOUR) {
    throw new GateError(ERR.ERR_NOT_IN_RIGOUR);
  }
  // 2. no RED
  const reds = checks.filter((c) => c.score === Score.RED);
  if (reds.length) {
    throw new GateError(ERR.ERR_RED_BLOCKS, {
      message: `Blocked: ${reds.length} red item${reds.length > 1 ? "s" : ""} must be resolved before signing.`,
      items: reds.map(summ),
    });
  }
  // 3. every AMBER has a non-empty override note
  const unnotedAmber = checks.filter(
    (c) => c.score === Score.AMBER && !(c.overrideNote && String(c.overrideNote).trim()),
  );
  if (unnotedAmber.length) {
    throw new GateError(ERR.ERR_AMBER_NEEDS_NOTE, {
      message: `${unnotedAmber.length} amber item${unnotedAmber.length > 1 ? "s" : ""} need an override note.`,
      items: unnotedAmber.map(summ),
    });
  }
  // 4. role gate
  if (!signerRoleOK(doc.type, actingUser?.role)) {
    throw new GateError(ERR.ERR_ROLE, {
      message:
        doc.type === DocType.BRD
          ? "Only a Product Owner can sign a BRD."
          : `Role ${actingUser?.role ?? "(none)"} may not sign a ${doc.type}.`,
    });
  }
}

function summ(c: RigourCheck): GateErrorItem {
  return { key: c.key, score: c.score, reason: c.reason };
}

// Deterministic, dependency-free content hash (FNV-1a 32-bit over canonical JSON).
// Enough to prove "what was signed" in the artifact (RIGOUR §6-B). The store may
// inject a stronger hash (e.g. SubtleCrypto SHA-256) via opts.hash.
export function defaultHash(content: DocContent): string {
  const json = canonicalJson(content);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "fnv1a-" + (h >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}
