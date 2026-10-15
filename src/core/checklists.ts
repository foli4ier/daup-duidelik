// duidelik — rigour checklist registry (frozen KEYS + content integration point)
//
// TWO ownership boundaries meet here, kept deliberately separate:
//
//   1. KEYS + which content field each reads + roll-up contract
//        → architect, RIGOUR-AND-SIGNING.md §1. Frozen below. Renaming a key is a
//          migration. The builder binds to these.
//
//   2. The exact ITEM WORDING (label/sub-label shown in the gate row) and the
//        precise GREEN/AMBER/RED criteria the deterministic layer encodes
//        → content, docs/content/rigour-checklist-wording.md. The builder does NOT
//          invent these. See CONTENT INTEGRATION POINT below.
//
// This module exposes the key skeleton + a slot for content's deterministic
// predicates. rigour.ts runs those predicates; aiClient.ts refines them. Ported
// verbatim from app/src/checklists.js.

import { DocType, CHECKLIST_VERSION, Score } from "./enums";
import type { DocTypeValue, ScoreValue } from "./enums";

// Context handed to every deterministic predicate (assembled by the store from the
// graph). All fields optional so a predicate can run on a partial document.
export interface ScoreContext {
  content?: Record<string, any>;
  product?: { ownerId?: string | null } & Record<string, any>;
  resolveUser?: (id: string) => unknown;
  placementIntact?: boolean;
  signedBrdKeys?: string[];
  now?: Date;
}

export interface DeterministicResult {
  score: ScoreValue;
  reason: string;
}

export interface ChecklistItemSpec {
  label: string;
  subLabel: string;
  deterministic: (ctx: ScoreContext) => DeterministicResult;
  _stub?: boolean;
  _source?: string;
}

export type ChecklistSpec = Record<string, ChecklistItemSpec>;

interface ChecklistKeyDef {
  key: string;
  reads: string;
}

/**
 * Frozen checklist keys per doc type (RIGOUR §1). `reads` is documentary: the
 * `content.*` / entity path the item is scored against — the real read logic lives
 * in the deterministic predicate supplied by content (see CHECKLIST_SPEC below).
 *
 * QRG: no checklist in v1 (LIFECYCLE §7-A) → empty list.
 */
export const CHECKLIST_KEYS: Record<DocTypeValue, readonly ChecklistKeyDef[]> = {
  [DocType.BRD]: [
    { key: "brd.decision_stated", reads: "content.decision" },
    { key: "brd.single_owner", reads: "content.ownerId / DataProduct.ownerId" },
    { key: "brd.measurable_success", reads: "content.successMetrics[]" },
    { key: "brd.scope_boundary", reads: "content.outOfScope[]" },
    { key: "brd.domain_placement", reads: "DataProduct.subDomainId chain" },
    { key: "brd.source_clarity", reads: "content.dataSources[]" },
  ],
  [DocType.FSD]: [
    { key: "fsd.traceable_to_brd", reads: "content.requirements[].brdRef ↔ signed BRD" },
    { key: "fsd.data_model_present", reads: "content.entities[]" },
    { key: "fsd.erd_attached", reads: "content.erd" },
    { key: "fsd.grain_stated", reads: "content.entities[].grain" },
    { key: "fsd.nonfunctionals", reads: "content.nonFunctionals" },
  ],
  [DocType.QRG]: [], // no gate in v1
};

export function checklistVersionFor(docType: DocTypeValue): string | null {
  return CHECKLIST_VERSION[docType] ?? null;
}

export function keysFor(docType: DocTypeValue): string[] {
  return (CHECKLIST_KEYS[docType] || []).map((k) => k.key);
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTENT INTEGRATION POINT
//
// content/rigour-checklist-wording.md defines, per key:
//   - label      : the gate-row text  (DESIGN-SYSTEM §6.11)
//   - subLabel   : the one-line question
//   - green/amber/red : the deterministic criteria
//   - deterministic(ctx) → { score, reason } : the code-floor predicate
//
// Until content ships an executable spec, STUBBED entries below carry the frozen
// labels from rigour-checklist-wording.md §1–§2 and a deterministic predicate that
// is INTENTIONALLY CONSERVATIVE: every stub returns a candidate score so the gate
// is wired end-to-end and demonstrably BLOCKS, but each is tagged `_stub: true` and
// `_source` so the content hand-off replaces them wholesale.
//
// Replace registerChecklistSpec(...) with content's generated spec; nothing else in
// rigour.ts / signing.ts changes.
// ──────────────────────────────────────────────────────────────────────────────

let _spec: ChecklistSpec | null = null;

/**
 * Install the executable checklist spec (from content). Shape:
 *   { [key]: { label, subLabel, deterministic(ctx) → {score, reason} } }
 * The deterministic predicate is the code FLOOR (RIGOUR §2) — it must never depend
 * on the AI and must return Score.RED/AMBER/GREEN + a one-line reason string.
 */
export function registerChecklistSpec(spec: ChecklistSpec): void {
  _spec = spec;
}

/** The installed spec, or the built-in stub if content has not registered one. */
export function getChecklistSpec(): ChecklistSpec {
  return _spec || STUB_SPEC;
}

// The vague-value set (content/rigour-checklist-wording.md §3). Shared deterministic
// rule: a field whose entire value is one of these tokens is "present but empty of
// meaning". A faithful copy of the content floor; the content spec may extend it.
export const VAGUE_TOKENS: readonly string[] = [
  "", "tbd", "tba", "n/a", "na", "none", "nothing", "various", "various systems",
  "several", "misc", "miscellaneous", "standard", "normal", "as usual", "the usual",
  "etc", "etc.", "to be defined", "to be decided", "placeholder", "xxx", "???",
];

export function isVague(value: unknown): boolean {
  if (value == null) return true;
  return VAGUE_TOKENS.includes(String(value).trim().toLowerCase());
}

export function hasNumber(value: unknown): boolean {
  return /\d/.test(String(value ?? ""));
}

// ──────────────────────────────────────────────────────────────────────────────
// STUB spec — placeholder until content delivers the executable spec.
// Labels copied verbatim from rigour-checklist-wording.md §1–§2. Predicates encode
// the documented deterministic rule faithfully, but are marked _stub so they are
// replaced, not relied on as the final wording owner.
// ──────────────────────────────────────────────────────────────────────────────

const stub = (
  label: string,
  subLabel: string,
  deterministic: (ctx: ScoreContext) => DeterministicResult,
): ChecklistItemSpec => ({
  label,
  subLabel,
  deterministic,
  _stub: true,
  _source: "docs/content/rigour-checklist-wording.md",
});

const STUB_SPEC: ChecklistSpec = {
  // ---- BRD (brd-v1) ----
  "brd.decision_stated": stub(
    "Decision stated",
    "What business decision or action does this product enable?",
    (ctx) => {
      const d = (ctx.content?.decision ?? "").trim();
      if (!d) return { score: Score.RED, reason: "No decision stated." };
      // weak/aspirational verbs with no actor/object → AMBER (content refines)
      const weak = /^(improve|enable|support|provide|give)\b/i.test(d) && d.split(/\s+/).length < 6;
      if (weak) {
        return {
          score: Score.AMBER,
          reason: `Vague decision ("${d}") — name a concrete action a role will take.`,
        };
      }
      return { score: Score.GREEN, reason: "Concrete decision stated." };
    },
  ),
  "brd.single_owner": stub(
    "Single owner",
    "One named accountable person owns this product.",
    (ctx) => {
      const ownerId = ctx.content?.ownerId ?? ctx.product?.ownerId ?? null;
      const resolves = ownerId && ctx.resolveUser && ctx.resolveUser(ownerId);
      if (!ownerId || !resolves) return { score: Score.RED, reason: "No single accountable owner." };
      return { score: Score.GREEN, reason: "One named owner." };
    },
  ),
  "brd.measurable_success": stub(
    "Measurable success",
    "At least one success metric with a numeric target.",
    (ctx) => {
      const ms: any[] = ctx.content?.successMetrics ?? [];
      if (!ms.length || !ms.some((m) => (m?.metric ?? "").trim())) {
        return { score: Score.RED, reason: "No success metric named." };
      }
      const missing = ms.filter((m) => !hasNumber(m?.target) || isVague(m?.target));
      if (missing.length) return { score: Score.AMBER, reason: "A metric has no numeric target." };
      return { score: Score.GREEN, reason: "Every metric has a numeric target." };
    },
  ),
  "brd.scope_boundary": stub(
    "Scope boundary",
    "What is explicitly out of scope?",
    (ctx) => {
      const oos: string[] = (ctx.content?.outOfScope ?? []).filter((x: string) => (x ?? "").trim());
      if (!oos.length) return { score: Score.RED, reason: "No scope boundary drawn." };
      if (oos.every((x) => isVague(x))) {
        return { score: Score.AMBER, reason: 'Out-of-scope is a filler ("none"/"N/A").' };
      }
      return { score: Score.GREEN, reason: "Specific out-of-scope item." };
    },
  ),
  "brd.domain_placement": stub(
    "Domain placement",
    "Assigned to a Stream → Domain → Sub-domain.",
    (ctx) => {
      const ok = ctx.placementIntact === true;
      return ok
        ? { score: Score.GREEN, reason: "Placed under Stream → Domain → Sub-domain." }
        : { score: Score.RED, reason: "Sub-domain placement missing or broken." };
    },
  ),
  "brd.source_clarity": stub(
    "Source clarity",
    "Data sources are named systems, not 'various'.",
    (ctx) => {
      const ds: any[] = ctx.content?.dataSources ?? [];
      if (!ds.length || !ds.some((s) => (s?.name ?? "").trim())) {
        return { score: Score.RED, reason: "No data sources named." };
      }
      if (ds.some((s) => isVague(s?.name))) {
        return { score: Score.AMBER, reason: 'A source is vague ("various").' };
      }
      return { score: Score.GREEN, reason: "Named source systems." };
    },
  ),

  // ---- FSD (fsd-v1) ----
  "fsd.traceable_to_brd": stub(
    "Traceable to BRD",
    "Every requirement maps to a key in the signed BRD.",
    (ctx) => {
      const reqs: any[] = ctx.content?.requirements ?? [];
      if (!reqs.length) return { score: Score.RED, reason: "No requirements." };
      if (reqs.some((r) => r?.brdRef == null)) {
        return { score: Score.RED, reason: "An untraceable requirement (brdRef null)." };
      }
      const keys = ctx.signedBrdKeys ?? [];
      const stale = reqs.filter((r) => !keys.includes(r.brdRef));
      if (stale.length) {
        return { score: Score.AMBER, reason: "A brdRef does not resolve to the signed BRD." };
      }
      return { score: Score.GREEN, reason: "Every requirement traces to the signed BRD." };
    },
  ),
  "fsd.data_model_present": stub(
    "Data model present",
    "Entities with at least one relationship — a model, not a list.",
    (ctx) => {
      const es: any[] = ctx.content?.entities ?? [];
      if (!es.length || !es.some((e) => (e?.name ?? "").trim())) {
        return { score: Score.RED, reason: "No entities." };
      }
      const anyRel = es.some((e) => (e?.relationships ?? []).length);
      if (es.length >= 2 && !anyRel) {
        return { score: Score.AMBER, reason: "Entities but no relationships (a list, not a model)." };
      }
      return { score: Score.GREEN, reason: "Entities with relationships." };
    },
  ),
  "fsd.erd_attached": stub(
    "ERD attached",
    "A diagram of the model exists.",
    (ctx) => {
      const erd = ctx.content?.erd;
      const src = (erd?.source ?? "").trim();
      const fmt = erd?.format;
      if (!src) return { score: Score.RED, reason: "No ERD source." };
      if (!["svg", "mermaid", "dbml"].includes(fmt)) {
        return { score: Score.AMBER, reason: "ERD format not recognised." };
      }
      return { score: Score.GREEN, reason: "ERD attached." };
    },
  ),
  "fsd.grain_stated": stub(
    "Grain stated",
    "The level of each table is explicit — one row = …",
    (ctx) => {
      const es: any[] = ctx.content?.entities ?? [];
      if (!es.length) return { score: Score.RED, reason: "No entities to grain." };
      if (es.some((e) => !(e?.grain ?? "").trim())) {
        return { score: Score.RED, reason: 'An entity has no grain ("grain TBD").' };
      }
      const vague = es.some((e) => !/per|one row/i.test(e.grain));
      if (vague) return { score: Score.AMBER, reason: "A grain is not a true grain statement." };
      return { score: Score.GREEN, reason: "Every entity has an explicit grain." };
    },
  ),
  "fsd.nonfunctionals": stub(
    "Non-functionals",
    "Refresh frequency, retention, and access/security are stated.",
    (ctx) => {
      const nf: Record<string, string> = ctx.content?.nonFunctionals ?? {};
      const keys = ["refresh", "retention", "access"];
      if (keys.some((k) => !(nf[k] ?? "").trim())) {
        return { score: Score.RED, reason: "A non-functional is empty." };
      }
      if (keys.some((k) => isVague(nf[k]))) {
        return { score: Score.AMBER, reason: 'A non-functional is a placeholder ("TBD").' };
      }
      return { score: Score.GREEN, reason: "Refresh, retention and access all stated." };
    },
  ),
};
