// duidelik — lifecycle state machine (LIFECYCLE.md §2–§6)
//
// THE ONLY code allowed to write DataProduct.stage and Document.status. The UI
// dispatches intents; it never mutates stage/status directly (STACK §2).
//
// Implements the legal-transition table (LIFECYCLE §6) exactly:
//   1 register → ONE_LINER
//   2 create BRD  (ONE_LINER, one-liner non-empty)          → stage BRD, BRD DRAFT
//   3 run BRD rigour (BRD DRAFT)                             → BRD IN_RIGOUR
//   4 edit BRD (any status)                                  → BRD DRAFT (+invalidate if was SIGNED)
//   5 sign BRD (GATE S, PO)                                  → BRD SIGNED
//   6 create FSD (stage BRD, BRD SIGNED  ← HARD GATE)        → stage FSD, FSD DRAFT
//   7 run FSD rigour                                         → FSD IN_RIGOUR
//   8 sign FSD (GATE S, any role)                            → FSD SIGNED
//   9 create QRG (stage FSD, FSD SIGNED)                     → stage QRG, QRG DRAFT
//  10 publish QRG (QRG DRAFT)                                → QRG PUBLISHED, stage LIVE
//  11 add/edit glossary term (product exists)               → no gate
//
// Anything not in the table is rejected. Each fn is pure over the store graph: it
// returns a patch { products?, documents?, signatures? } the store applies, or
// throws a TransitionError. invalidateDownstream is an EXPLICIT function called by
// the edit path (LIFECYCLE §5) — not a hidden setter side-effect.
//
// Ported verbatim (logic) from app/src/lifecycle.js; JS→TS typing only.

import { LifecycleStage, DocStatus, DocType, stageIndex } from "./enums";
import type { LifecycleStageValue, DocTypeValue } from "./enums";
import { signDocument } from "./signing";
import type { SignOpts, SignResult } from "./signing";
import { checklistVersionFor } from "./checklists";
import type { DataProduct, DuidelikDocument, RigourCheck, ActingUser } from "../types";

export class TransitionError extends Error {
  code: string;
  constructor(message: string, code = "ILLEGAL_TRANSITION") {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}

interface GenOpts {
  genId?: () => string | undefined;
  now?: Date;
}

export interface CreateDocResult {
  product: DataProduct;
  document: DuidelikDocument;
}

// ── 2. Create a BRD ───────────────────────────────────────────────────────────
export function createBrd(product: DataProduct, { genId, now = new Date() }: GenOpts = {}): CreateDocResult {
  if (product.stage !== LifecycleStage.ONE_LINER) {
    throw new TransitionError(`Cannot create BRD from stage ${product.stage}.`);
  }
  if (!(product.oneLiner && product.oneLiner.trim())) {
    throw new TransitionError("One-liner must be non-empty to create a BRD.", "EMPTY_ONE_LINER");
  }
  const doc = newDocument(DocType.BRD, product.id, { genId, now });
  const nextProduct: DataProduct = { ...product, stage: LifecycleStage.BRD, updatedAt: iso(now) };
  return { product: nextProduct, document: doc };
}

// ── 6. Create an FSD — HARD GATE: BRD must be SIGNED ────────────────────────────
export function createFsd(
  product: DataProduct,
  brd: DuidelikDocument | null,
  { genId, now = new Date() }: GenOpts = {},
): CreateDocResult {
  if (product.stage !== LifecycleStage.BRD) {
    throw new TransitionError(`Cannot create FSD from stage ${product.stage}.`);
  }
  if (!brd || brd.type !== DocType.BRD) {
    throw new TransitionError("No BRD to gate the FSD against.", "NO_BRD");
  }
  if (brd.status !== DocStatus.SIGNED) {
    // THE HARD GATE (LIFECYCLE §2): no FSD until the BRD is signed.
    throw new TransitionError("BRD must be SIGNED before an FSD can be created.", "BRD_NOT_SIGNED");
  }
  const doc = newDocument(DocType.FSD, product.id, { genId, now });
  const nextProduct: DataProduct = { ...product, stage: LifecycleStage.FSD, updatedAt: iso(now) };
  return { product: nextProduct, document: doc };
}

// ── 9. Create a QRG — gate: FSD must be SIGNED ─────────────────────────────────
export function createQrg(
  product: DataProduct,
  fsd: DuidelikDocument | null,
  { genId, now = new Date() }: GenOpts = {},
): CreateDocResult {
  if (product.stage !== LifecycleStage.FSD) {
    throw new TransitionError(`Cannot create QRG from stage ${product.stage}.`);
  }
  if (!fsd || fsd.type !== DocType.FSD || fsd.status !== DocStatus.SIGNED) {
    throw new TransitionError("FSD must be SIGNED before a QRG can be created.", "FSD_NOT_SIGNED");
  }
  const doc = newDocument(DocType.QRG, product.id, { genId, now });
  const nextProduct: DataProduct = { ...product, stage: LifecycleStage.QRG, updatedAt: iso(now) };
  return { product: nextProduct, document: doc };
}

// ── 3/7. Start rigour (DRAFT → IN_RIGOUR) ──────────────────────────────────────
export function startRigour(doc: DuidelikDocument, { now = new Date() }: GenOpts = {}): { document: DuidelikDocument } {
  if (doc.type === DocType.QRG) {
    throw new TransitionError("QRG has no rigour gate in v1.", "NO_QRG_GATE");
  }
  if (doc.status !== DocStatus.DRAFT) {
    throw new TransitionError(`Rigour can only start from DRAFT (got ${doc.status}).`);
  }
  return { document: { ...doc, status: DocStatus.IN_RIGOUR, updatedAt: iso(now) } };
}

export interface Invalidation {
  product: DataProduct;
  documents: DuidelikDocument[];
  banner: string;
}

export interface EditResult {
  document: DuidelikDocument;
  invalidation?: Invalidation;
}

// ── 4. Edit a document — always drops to DRAFT; cascades if it was SIGNED ───────
export function editDocument(
  doc: DuidelikDocument,
  product: DataProduct,
  allDocs: DuidelikDocument[],
  { now = new Date() }: GenOpts = {},
): EditResult {
  const wasSigned = doc.status === DocStatus.SIGNED;
  const edited: DuidelikDocument = { ...doc, status: DocStatus.DRAFT, updatedAt: iso(now) };
  if (!wasSigned) return { document: edited };

  // Editing a SIGNED doc → invalidation cascade (LIFECYCLE §5).
  const invalidation = invalidateDownstream(doc, product, allDocs, { now });
  return { document: edited, invalidation };
}

// ── 5/8. Sign (GATE S) + maybe unlock next stage ───────────────────────────────
export function signAndMaybeUnlock(
  doc: DuidelikDocument,
  checks: RigourCheck[],
  actingUser: ActingUser,
  opts: SignOpts = {},
): SignResult {
  const result = signDocument(doc, checks, actingUser, opts);
  if (!result.ok) return result; // GateError.toResult — caller shows the §5 reason
  // Stage unlock is a CONSEQUENCE of the signature (LIFECYCLE §2) and is handled by
  // the store when it persists: a signed BRD leaves the product at stage BRD and
  // merely permits createFsd. No stage write happens on sign itself.
  return result;
}

// ── 10. Publish QRG (QRG DRAFT → PUBLISHED, stage → LIVE) ───────────────────────
export function publishQrg(
  product: DataProduct,
  qrg: DuidelikDocument | null,
  { now = new Date() }: GenOpts = {},
): CreateDocResult {
  if (!qrg || qrg.type !== DocType.QRG) throw new TransitionError("Not a QRG.", "NOT_QRG");
  if (qrg.status !== DocStatus.DRAFT) {
    throw new TransitionError(`QRG must be DRAFT to publish (got ${qrg.status}).`);
  }
  const document: DuidelikDocument = { ...qrg, status: DocStatus.PUBLISHED, updatedAt: iso(now) };
  const nextProduct: DataProduct = { ...product, stage: LifecycleStage.LIVE, updatedAt: iso(now) };
  return { product: nextProduct, document };
}

// ── §5. Invalidation cascade (EXPLICIT, called by the edit path) ────────────────
/**
 * When a SIGNED document is edited, pull the product stage back to that document's
 * stage and force every downstream document to DRAFT so its (now-suspect)
 * dependencies are re-verified. The old Signature stays on record (historical) — we
 * never delete it; its documentHash no longer matches, which is the proof it is stale.
 */
export function invalidateDownstream(
  editedDoc: DuidelikDocument,
  product: DataProduct,
  allDocs: DuidelikDocument[],
  { now = new Date() }: GenOpts = {},
): Invalidation {
  const docStageIdx = stageIndex(stageForDocType(editedDoc.type));
  // Pull stage back to the edited document's own stage.
  const nextProduct: DataProduct = {
    ...product,
    stage: stageForDocType(editedDoc.type),
    updatedAt: iso(now),
  };

  // Force every document whose stage is strictly downstream back to DRAFT.
  const downstream = allDocs.filter((d) => {
    if (d.id === editedDoc.id) return false;
    return stageIndex(stageForDocType(d.type)) > docStageIdx;
  });
  // A downstream doc returns to DRAFT regardless of whether it was SIGNED or
  // PUBLISHED — its dependency on the edited doc is now suspect (LIFECYCLE §5).
  const documents: DuidelikDocument[] = downstream.map((d) => ({
    ...d,
    status: DocStatus.DRAFT,
    updatedAt: iso(now),
  }));

  const banner = buildBanner(editedDoc.type, downstream.map((d) => d.type));
  return { product: nextProduct, documents, banner };
}

function buildBanner(editedType: DocTypeValue, downstreamTypes: DocTypeValue[]): string {
  if (!downstreamTypes.length) {
    return `${editedType} edited after signing — it has returned to DRAFT and must be re-rigoured and re-signed.`;
  }
  return `${editedType} edited after signing — ${downstreamTypes.join(
    ", ",
  )} must be re-rigoured and re-signed (invalidation cascade).`;
}

// stage a document type lives at (BRD doc → BRD stage, etc.)
function stageForDocType(type: DocTypeValue): LifecycleStageValue {
  const map: Record<DocTypeValue, LifecycleStageValue> = {
    [DocType.BRD]: LifecycleStage.BRD,
    [DocType.FSD]: LifecycleStage.FSD,
    [DocType.QRG]: LifecycleStage.QRG,
  };
  return map[type];
}

function newDocument(type: DocTypeValue, dataProductId: string, { genId, now }: GenOpts): DuidelikDocument {
  const stamp = iso(now);
  return {
    id: (genId ? genId() : undefined) as string,
    dataProductId,
    type,
    status: DocStatus.DRAFT,
    content: {}, // section schema owned by content (docs/templates/*); seeded by co-author/UI
    checklistVersion: checklistVersionFor(type),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function iso(now?: Date): string {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}
