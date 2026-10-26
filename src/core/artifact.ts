// duidelik — per-artifact export / import (STACK.md §3, extended to per-document grain)
//
// WHY this exists, and the trust posture it serves:
// Until daup.co.za is secured for server-side storage, enterprise data stays on the
// organisation's own corporate file share (e.g. SharePoint). duidelik v1 is a
// browser-only webapp artifact with NO backend and NO secrets in client code
// (STACK §4, SECURITY-BRIEFING §4). A browser cannot silently write a SharePoint
// document library (that needs Microsoft Graph + OAuth — a launch-grade integration).
// So "store duidelik artifacts on SharePoint" is delivered as a FILE round-trip:
//   export  → a self-contained, versioned .json the human saves to SharePoint;
//   import  → a file picker that reads a file the human synced/downloaded back.
// SharePoint is simply the folder the file lives in; duidelik stays a sovereign client
// (CONCEPT §9 data sovereignty). The Graph-API "Save/Open to SharePoint" buttons are a
// later, separate effort — the envelope contract here is forward-compatible with it.
//
// This module is PURE (no DOM, no store, no React) so it is unit-testable and the UI /
// store just call build/parse. The whole-registry export/import already in
// core/store.ts (exportJson/importJson) is unchanged; this adds the per-artifact grain
// the user asked for (one BRD / FSD / QRG / Glossary at a time).
//
// SECURITY: parse() treats the imported file as fully untrusted — it validates the
// envelope shape, the kind, and (for a document) the doc type, and NEVER trusts an
// embedded status/stage/signature as authoritative. An imported document is applied
// through the normal EDIT_DOCUMENT path (store), which drops a signed doc to DRAFT and
// re-runs the invalidation cascade (LIFECYCLE §5): you re-rigour and re-sign after an
// import, so the audit trail is never forged by a file.

import { DocType } from "./enums";
import type { DocTypeValue } from "./enums";
import type {
  DataProduct,
  DuidelikDocument,
  GlossaryTerm,
  Signature,
  DocContent,
} from "../types";

export const ARTIFACT_FORMAT = "duidelik.artifact";
export const ARTIFACT_FORMAT_VERSION = 1;

export type ArtifactKind = "BRD" | "FSD" | "QRG" | "GLOSSARY";

// A small, human-readable header so a file found later in SharePoint is self-describing
// (which product, which placement, which node/place it came from) without opening the app.
export interface ArtifactHeader {
  productId: string;
  productCode: string;
  productName: string;
  placement: string; // "duidelik › Stream › Domain › Sub-domain"
  placeId: string | null; // the originating place (data sovereignty context), may be null in standalone
  exportedAt: string; // ISO
}

// The signature is included for CONTEXT only (so a reader sees it was signed, by whom,
// against which checklist). It is NEVER re-applied on import — importing re-opens the
// doc to DRAFT (see module header). documentHash lets a reader verify the exported
// content matches what was signed.
export interface ArtifactSignatureContext {
  signedByName: string;
  signedByRole: string;
  signedAt: string;
  checklistVersion: string | null;
  documentHash: string;
}

export interface DocumentArtifact {
  format: typeof ARTIFACT_FORMAT;
  formatVersion: number;
  kind: "BRD" | "FSD" | "QRG";
  header: ArtifactHeader;
  // the document body as authored (content is content's schema — we do not re-shape it)
  document: {
    type: DocTypeValue;
    checklistVersion: string | null;
    content: DocContent;
  };
  signature: ArtifactSignatureContext | null;
}

export interface GlossaryArtifact {
  format: typeof ARTIFACT_FORMAT;
  formatVersion: number;
  kind: "GLOSSARY";
  header: ArtifactHeader;
  terms: Array<{ term: string; definition: string }>;
}

export type Artifact = DocumentArtifact | GlossaryArtifact;

// ── build (export) ──────────────────────────────────────────────────────────────

export interface BuildContext {
  product: DataProduct;
  placement: string;
  placeId: string | null;
  resolveUserName: (id: string) => string;
  now?: Date;
}

export function buildDocumentArtifact(
  doc: DuidelikDocument,
  signature: Signature | null,
  ctx: BuildContext,
): DocumentArtifact {
  return {
    format: ARTIFACT_FORMAT,
    formatVersion: ARTIFACT_FORMAT_VERSION,
    kind: doc.type as "BRD" | "FSD" | "QRG",
    header: header(ctx),
    document: {
      type: doc.type,
      checklistVersion: doc.checklistVersion,
      content: doc.content || {},
    },
    signature: signature
      ? {
          signedByName: ctx.resolveUserName(signature.signedById),
          signedByRole: signature.signedByRole,
          signedAt: signature.signedAt,
          checklistVersion: signature.checklistVersion,
          documentHash: signature.documentHash,
        }
      : null,
  };
}

export function buildGlossaryArtifact(terms: GlossaryTerm[], ctx: BuildContext): GlossaryArtifact {
  return {
    format: ARTIFACT_FORMAT,
    formatVersion: ARTIFACT_FORMAT_VERSION,
    kind: "GLOSSARY",
    header: header(ctx),
    terms: terms
      .filter((t) => t.term && t.term.trim())
      .map((t) => ({ term: t.term, definition: t.definition })),
  };
}

function header(ctx: BuildContext): ArtifactHeader {
  return {
    productId: ctx.product.id,
    productCode: ctx.product.code,
    productName: ctx.product.name,
    placement: ctx.placement,
    placeId: ctx.placeId,
    exportedAt: (ctx.now ?? new Date()).toISOString(),
  };
}

export function artifactJson(a: Artifact): string {
  return JSON.stringify(a, null, 2);
}

// A SharePoint-/filesystem-safe download filename. Example:
//   duidelik-DAPP-6007-BRD.json  /  duidelik-DAPP-6007-GLOSSARY.json
export function artifactFilename(a: Artifact): string {
  const code = sanitize(a.header.productCode || a.header.productId || "product");
  return `duidelik-${code}-${a.kind}.json`;
}

function sanitize(s: string): string {
  // keep alnum, dash, underscore; collapse the rest to a dash; trim repeats.
  return (s || "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "product";
}

// ── parse (import) — untrusted input ──────────────────────────────────────────

export class ArtifactError extends Error {
  code: string;
  constructor(message: string, code = "ARTIFACT_INVALID") {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

/**
 * Parse + validate an imported file (string or already-parsed object) into a typed
 * Artifact. Throws ArtifactError with a human message on any shape problem. Does NOT
 * apply anything — the caller (store) decides how to merge, and ALWAYS routes a
 * document through EDIT_DOCUMENT so a signed doc drops to DRAFT (never forges a sign).
 */
export function parseArtifact(input: string | unknown): Artifact {
  let obj: unknown;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      throw new ArtifactError("This file is not valid JSON.", "NOT_JSON");
    }
  } else {
    obj = input;
  }
  if (!obj || typeof obj !== "object") {
    throw new ArtifactError("This file is not a duidelik artifact.", "NOT_ARTIFACT");
  }
  const a = obj as Record<string, unknown>;
  if (a.format !== ARTIFACT_FORMAT) {
    throw new ArtifactError("This file is not a duidelik artifact export.", "NOT_ARTIFACT");
  }
  if (typeof a.formatVersion !== "number" || a.formatVersion > ARTIFACT_FORMAT_VERSION) {
    throw new ArtifactError(
      `This artifact was exported by a newer duidelik (format v${String(a.formatVersion)}). Update before importing.`,
      "VERSION_AHEAD",
    );
  }
  const kind = a.kind;
  if (kind !== "BRD" && kind !== "FSD" && kind !== "QRG" && kind !== "GLOSSARY") {
    throw new ArtifactError(`Unknown artifact kind "${String(kind)}".`, "BAD_KIND");
  }
  validateHeader(a.header);

  if (kind === "GLOSSARY") {
    if (!Array.isArray(a.terms)) {
      throw new ArtifactError("Glossary artifact has no terms array.", "BAD_GLOSSARY");
    }
    const terms = a.terms.map((t, i) => {
      const row = (t ?? {}) as Record<string, unknown>;
      const term = typeof row.term === "string" ? row.term : "";
      const definition = typeof row.definition === "string" ? row.definition : "";
      if (!term.trim()) {
        throw new ArtifactError(`Glossary term #${i + 1} has no term text.`, "BAD_GLOSSARY");
      }
      return { term, definition };
    });
    return {
      format: ARTIFACT_FORMAT,
      formatVersion: a.formatVersion,
      kind: "GLOSSARY",
      header: a.header as unknown as ArtifactHeader,
      terms,
    };
  }

  // document artifact
  const docObj = a.document as Record<string, unknown> | undefined;
  if (!docObj || typeof docObj !== "object") {
    throw new ArtifactError("Artifact has no document body.", "BAD_DOCUMENT");
  }
  if (docObj.type !== kind) {
    throw new ArtifactError(
      `Artifact kind (${kind}) does not match its document type (${String(docObj.type)}).`,
      "TYPE_MISMATCH",
    );
  }
  if (!docObj.content || typeof docObj.content !== "object") {
    throw new ArtifactError("Artifact document has no content.", "BAD_DOCUMENT");
  }
  return {
    format: ARTIFACT_FORMAT,
    formatVersion: a.formatVersion,
    kind: kind as "BRD" | "FSD" | "QRG",
    header: a.header as unknown as ArtifactHeader,
    document: {
      type: docObj.type as DocTypeValue,
      checklistVersion:
        typeof docObj.checklistVersion === "string" ? docObj.checklistVersion : null,
      content: docObj.content as DocContent,
    },
    signature: (a.signature ?? null) as ArtifactSignatureContext | null,
  };
}

function validateHeader(h: unknown): void {
  if (!h || typeof h !== "object") {
    throw new ArtifactError("Artifact is missing its header.", "BAD_HEADER");
  }
  const hh = h as Record<string, unknown>;
  if (typeof hh.productCode !== "string" && typeof hh.productId !== "string") {
    throw new ArtifactError("Artifact header names no product.", "BAD_HEADER");
  }
}

// Is this artifact importable INTO the given product? A document artifact is meant for
// the product it was exported from (same code/id); importing a BRD exported from a
// DIFFERENT product into this one is almost always a mistake, so the caller should warn.
// Returns a reason string when there is a mismatch to surface, else null (clean match).
export function productMismatchReason(
  a: Artifact,
  target: DataProduct,
): string | null {
  const sameId = a.header.productId && a.header.productId === target.id;
  const sameCode = a.header.productCode && a.header.productCode === target.code;
  if (sameId || sameCode) return null;
  return `This ${a.kind} was exported from "${a.header.productName || a.header.productCode || "another product"}", not "${target.name}". Importing it will overwrite this product's ${a.kind}.`;
}

export function isDocumentArtifact(a: Artifact): a is DocumentArtifact {
  return a.kind === "BRD" || a.kind === "FSD" || a.kind === "QRG";
}

// Map an artifact document kind to the runtime DocType (identity, but typed).
export function docTypeOf(a: DocumentArtifact): DocTypeValue {
  return a.kind === "BRD" ? DocType.BRD : a.kind === "FSD" ? DocType.FSD : DocType.QRG;
}
