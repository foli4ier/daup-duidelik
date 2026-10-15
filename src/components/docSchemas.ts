// duidelik — document section schemas (UI driver)
//
// DESIGN-SYSTEM §6.8/§11: the doc-shell renders "a list of sections with fields", NOT
// a fixed layout — so content's field schema (docs/templates/*) drops in without a
// design change. This module encodes those template schemas DECLARATIVELY: field
// names, kinds, labels and which rigour key a field feeds. The React doc-shell walks
// these; it never hard-codes a doc type's fields.
//
// Field names here are content's wire contract (BRD/FSD/QRG templates §2) — do not
// rename. If content changes a schema, edit this table, not the components.
//
// Ported verbatim (logic) from app/src/docSchemas.js; JS→TS typing only.

import { DocType } from "../core/enums";
import type { DocTypeValue } from "../core/enums";

// field kinds the generic editor understands:
export type FieldKind =
  | "text"
  | "textarea"
  | "string-list"
  | "owner-picker"
  | "readonly-oneliner"
  | "readonly-breadcrumb"
  | "metric-list"
  | "source-list"
  | "requirement-list"
  | "entity-list"
  | "erd"
  | "nfr"
  | "usecase-list"
  | "keyfield-list"
  | "glossary-link-list"
  | "related-link-list";

export interface FieldSchema {
  key: string;
  kind: FieldKind;
  label: string;
  optional?: boolean;
  hint?: string;
}

export interface SectionSchema {
  id: string;
  label: string;
  rigourKey?: string;
  fields: FieldSchema[];
}

export const SECTION_SCHEMAS: Record<DocTypeValue, SectionSchema[]> = {
  [DocType.BRD]: [
    { id: "request", label: "The request", fields: [
      { key: "oneLiner", kind: "readonly-oneliner", label: "One-line request" },
      { key: "requestContext", kind: "textarea", label: "Request context", optional: true },
    ] },
    { id: "decision", label: "Decision this enables", rigourKey: "brd.decision_stated", fields: [
      { key: "decision", kind: "textarea", label: "Business decision",
        hint: 'A specific decision or action a named role will take differently. Not "improve visibility".' },
      { key: "decisionActor", kind: "text", label: "Whose decision (role/team)", optional: true },
    ] },
    { id: "owner", label: "Accountable owner", rigourKey: "brd.single_owner", fields: [
      { key: "ownerId", kind: "owner-picker", label: "Product Owner" },
    ] },
    { id: "success", label: "How we'll know it worked", rigourKey: "brd.measurable_success", fields: [
      { key: "successMetrics", kind: "metric-list", label: "Success metrics" },
    ] },
    { id: "scope", label: "Scope boundary", rigourKey: "brd.scope_boundary", fields: [
      { key: "inScope", kind: "string-list", label: "In scope", optional: true },
      { key: "outOfScope", kind: "string-list", label: "Out of scope" },
    ] },
    { id: "placement", label: "Domain placement", rigourKey: "brd.domain_placement", fields: [
      { key: "__placement", kind: "readonly-breadcrumb", label: "Stream › Domain › Sub-domain" },
    ] },
    { id: "sources", label: "Data sources", rigourKey: "brd.source_clarity", fields: [
      { key: "dataSources", kind: "source-list", label: "Named source systems" },
    ] },
    { id: "narrative", label: "Background / assumptions / open questions", fields: [
      { key: "background", kind: "textarea", label: "Background", optional: true },
      { key: "assumptions", kind: "string-list", label: "Assumptions", optional: true },
      { key: "openQuestions", kind: "string-list", label: "Open questions", optional: true },
    ] },
  ],

  [DocType.FSD]: [
    { id: "requirements", label: "Traceable requirements", rigourKey: "fsd.traceable_to_brd", fields: [
      { key: "requirements", kind: "requirement-list", label: "Requirements (each traces to the signed BRD)" },
    ] },
    { id: "model", label: "Data model — entities & grain", rigourKey: "fsd.data_model_present", fields: [
      { key: "entities", kind: "entity-list", label: "Entities" },
    ] },
    { id: "erd", label: "Entity relationship diagram", rigourKey: "fsd.erd_attached", fields: [
      { key: "erd", kind: "erd", label: "ERD" },
    ] },
    { id: "nfr", label: "Non-functional requirements", rigourKey: "fsd.nonfunctionals", fields: [
      { key: "nonFunctionals", kind: "nfr", label: "Refresh · Retention · Access" },
    ] },
    { id: "narrative", label: "Design notes / assumptions / open questions", fields: [
      { key: "designNotes", kind: "textarea", label: "Design notes", optional: true },
      { key: "assumptions", kind: "string-list", label: "Assumptions", optional: true },
      { key: "openQuestions", kind: "string-list", label: "Open questions", optional: true },
    ] },
  ],

  [DocType.QRG]: [
    { id: "what", label: "What this product is", fields: [
      { key: "summary", kind: "textarea", label: "Summary (required to publish)" },
      { key: "audience", kind: "string-list", label: "Audience", optional: true },
    ] },
    { id: "use", label: "What to use it for", fields: [
      { key: "useCases", kind: "usecase-list", label: "Use cases", optional: true },
    ] },
    { id: "read", label: "How to read it", fields: [
      { key: "keyFields", kind: "keyfield-list", label: "Key fields", optional: true },
      { key: "grainNote", kind: "textarea", label: "Grain note", optional: true },
    ] },
    { id: "fresh", label: "Freshness & access", fields: [
      { key: "refresh", kind: "text", label: "Refresh", optional: true },
      { key: "accessNote", kind: "text", label: "Access", optional: true },
    ] },
    { id: "next", label: "Glossary & contacts", fields: [
      { key: "glossaryTermIds", kind: "glossary-link-list", label: "Linked glossary terms", optional: true },
      { key: "ownerContact", kind: "text", label: "Owner contact", optional: true },
      { key: "relatedLinks", kind: "related-link-list", label: "Related links", optional: true },
    ] },
    { id: "notes", label: "Notes", fields: [
      { key: "notes", kind: "textarea", label: "Notes", optional: true },
    ] },
  ],
};

export function sectionsFor(docType: DocTypeValue): SectionSchema[] {
  return SECTION_SCHEMAS[docType] || [];
}
