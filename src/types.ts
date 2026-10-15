// daup-duidelik — data-model types (docs/DATA-MODEL.md §3–§4)
//
// These types ARE the wire/storage contract. Field names match DATA-MODEL.md exactly
// — do not rename downstream. The core/ engine and the UI both bind to them. Enum
// string unions are derived from core/enums.ts so the frozen runtime values and the
// compile-time types cannot drift.

import type {
  LifecycleStage as LifecycleStageEnum,
  DocStatus as DocStatusEnum,
  DocType as DocTypeEnum,
  Score as ScoreEnum,
  Role as RoleEnum,
} from "./core/enums";

// ── enum string unions (DATA-MODEL §4) ──────────────────────────────────────────
export type LifecycleStage = (typeof LifecycleStageEnum)[keyof typeof LifecycleStageEnum];
export type DocStatus = (typeof DocStatusEnum)[keyof typeof DocStatusEnum];
export type DocType = (typeof DocTypeEnum)[keyof typeof DocTypeEnum];
export type Score = (typeof ScoreEnum)[keyof typeof ScoreEnum];
export type Role = (typeof RoleEnum)[keyof typeof RoleEnum];

// ── registry tree (DATA-MODEL §3) ───────────────────────────────────────────────
export interface Stream {
  id: string;
  name: string;
  order: number;
}

export interface Domain {
  id: string;
  streamId: string;
  name: string;
  description: string | null;
  order: number;
}

export interface SubDomain {
  id: string;
  domainId: string;
  name: string;
  order: number;
}

export interface DataProduct {
  id: string;
  code: string;
  subDomainId: string;
  name: string;
  oneLiner: string;
  stage: LifecycleStage;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  createdById?: string | null;
}

// `Document.content` is structured JSON whose per-doc-type section shape is owned by
// content (docs/templates/*). The engine reads named fields but never fixes the whole
// shape, so this is an open record, not a closed interface.
export type DocContent = Record<string, unknown>;

export interface DuidelikDocument {
  id: string;
  dataProductId: string;
  type: DocType;
  status: DocStatus;
  content: DocContent;
  checklistVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GlossaryTerm {
  id: string;
  dataProductId: string;
  term: string;
  definition: string;
  createdAt: string;
  updatedAt: string;
}

export interface RigourCheck {
  id?: string;
  documentId: string;
  key: string;
  score: Score;
  reason: string;
  overrideNote: string | null;
  overriddenById: string | null;
  overriddenAt: string | null;
  scoredAt: string;
}

// A frozen checklist row captured into a Signature (RIGOUR §3).
export interface ChecklistSnapshotRow {
  key: string;
  score: Score;
  reason: string;
  overrideNote: string | null;
  overriddenById: string | null;
}

export interface Signature {
  id?: string;
  documentId: string;
  signedById: string;
  signedByRole: Role;
  signedAt: string;
  checklistVersion: string | null;
  checklistSnapshot: ReadonlyArray<ChecklistSnapshotRow>;
  documentHash: string;
}

export interface User {
  id: string;
  name: string;
  role: Role;
}

// A per-place role roster entry (DAUP-PORT-PLAN §5 / O1). The house session carries
// NO role — duidelik owns authorization. A member is keyed by the session's stable
// identity (peerId preferred, phone fallback). The first person to redeem into a place
// bootstraps as PRODUCT_OWNER; a PO assigns roles to others who redeem in; an unknown
// person is NOT a member and fails safe to the lowest privilege (view/draft, no sign).
export interface PlaceMember {
  // Stable key = peerId if present, else phone. One roster row per person per place.
  key: string;
  peerId: string | null;
  phone: string | null;
  role: Role;
  // Display name is best-effort (the session has no name); defaults to a masked phone
  // or a short peer id until a PO renames. Never a security field.
  name: string;
  bootstrap: boolean; // true for the first-redeemer PO
  createdAt: string;
  updatedAt: string;
}

// ── the serialized object graph (STACK §3) ──────────────────────────────────────
export interface StoreGraph {
  schemaVersion: number;
  streams: Stream[];
  domains: Domain[];
  subDomains: SubDomain[];
  dataProducts: DataProduct[];
  documents: DuidelikDocument[];
  glossaryTerms: GlossaryTerm[];
  rigourChecks: RigourCheck[];
  signatures: Signature[];
  users: User[];
  // Per-place role roster (schemaVersion ≥ 2). Empty/absent in the standalone v1
  // fallback, where identity comes from the seeded `users` picker instead.
  members?: PlaceMember[];
}

// The acting identity the sign gate reads. In v1 (and the standalone fallback) this
// is a seeded user; under the house session (P3) it becomes { id: peerId, role }
// resolved from the per-place role roster (DAUP-PORT-PLAN §5). Shape is stable.
export interface ActingUser {
  id: string;
  role: Role;
}
