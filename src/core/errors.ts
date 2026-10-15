// duidelik — GATE S error contract (RIGOUR-AND-SIGNING.md §5)
//
// The UI binds to these exact codes. A failed sign/transition returns a GateError
// (or {ok:false, error}) carrying one of these codes + a human message + the
// offending items, so the signature panel can show the reason next to the button
// (DESIGN-SYSTEM.md §6.12, Principle 2: never a bare disabled button). Ported
// verbatim from app/src/errors.js.

export const ERR = {
  ERR_NOT_IN_RIGOUR: "ERR_NOT_IN_RIGOUR",
  ERR_RED_BLOCKS: "ERR_RED_BLOCKS",
  ERR_AMBER_NEEDS_NOTE: "ERR_AMBER_NEEDS_NOTE",
  ERR_ROLE: "ERR_ROLE",
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

// Default UI copy per RIGOUR §5. The UI MAY override with content wording, but a
// code always carries a non-empty default so the reason line is never blank.
export const ERR_MESSAGE: Record<ErrCode, string> = {
  [ERR.ERR_NOT_IN_RIGOUR]: "Run rigour first.",
  [ERR.ERR_RED_BLOCKS]: "Blocked: red items must be resolved before signing.",
  [ERR.ERR_AMBER_NEEDS_NOTE]: "Amber items need an override note before signing.",
  [ERR.ERR_ROLE]: "Only a Product Owner can sign a BRD.",
};

export interface GateErrorItem {
  key: string;
  score: string;
  reason: string;
}

export interface GateResult {
  ok: false;
  code: ErrCode;
  message: string;
  items: GateErrorItem[];
}

export interface GateErrorOpts {
  message?: string;
  items?: GateErrorItem[];
}

export class GateError extends Error {
  code: ErrCode;
  items: GateErrorItem[];

  constructor(code: ErrCode, opts: GateErrorOpts = {}) {
    super(opts.message || ERR_MESSAGE[code] || code);
    this.name = "GateError";
    this.code = code;
    this.items = opts.items || [];
  }

  toResult(): GateResult {
    return { ok: false, code: this.code, message: this.message, items: this.items };
  }
}
