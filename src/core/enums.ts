// duidelik — frozen enumerations (DATA-MODEL.md §4)
//
// These enum string values ARE the wire/storage contract. Do not rename downstream
// without updating DATA-MODEL.md. Exported as frozen objects so a typo in a
// transition fn fails loudly rather than writing a bad status. Ported verbatim from
// the v1 app/src/enums.js; `as const` added so TS derives the string unions.

export const LifecycleStage = {
  ONE_LINER: "ONE_LINER",
  BRD: "BRD",
  FSD: "FSD",
  QRG: "QRG",
  LIVE: "LIVE",
} as const;

export const DocStatus = {
  DRAFT: "DRAFT",
  IN_RIGOUR: "IN_RIGOUR",
  SIGNED: "SIGNED",
  PUBLISHED: "PUBLISHED", // QRG only
} as const;

export const DocType = {
  BRD: "BRD",
  FSD: "FSD",
  QRG: "QRG",
} as const;

export const Score = {
  GREEN: "GREEN",
  AMBER: "AMBER",
  RED: "RED",
} as const;

export const Role = {
  PRODUCT_MANAGER: "PRODUCT_MANAGER",
  PRODUCT_OWNER: "PRODUCT_OWNER",
  BUSINESS_ANALYST: "BUSINESS_ANALYST",
  FUNCTIONAL_ANALYST: "FUNCTIONAL_ANALYST",
} as const;

export type LifecycleStageValue = (typeof LifecycleStage)[keyof typeof LifecycleStage];
export type DocStatusValue = (typeof DocStatus)[keyof typeof DocStatus];
export type DocTypeValue = (typeof DocType)[keyof typeof DocType];
export type ScoreValue = (typeof Score)[keyof typeof Score];
export type RoleValue = (typeof Role)[keyof typeof Role];

// Stage ordering for "pull back" invalidation + rail rendering (LIFECYCLE §2).
export const STAGE_ORDER: readonly LifecycleStageValue[] = [
  LifecycleStage.ONE_LINER,
  LifecycleStage.BRD,
  LifecycleStage.FSD,
  LifecycleStage.QRG,
  LifecycleStage.LIVE,
] as const;

export function stageIndex(stage: LifecycleStageValue): number {
  return STAGE_ORDER.indexOf(stage);
}

// The checklist version each doc type signs against (frozen, RIGOUR §1).
export const CHECKLIST_VERSION: Record<DocTypeValue, string | null> = {
  [DocType.BRD]: "brd-v1",
  [DocType.FSD]: "fsd-v1",
  [DocType.QRG]: null, // no checklist in v1
};
