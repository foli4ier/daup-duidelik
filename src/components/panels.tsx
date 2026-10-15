// duidelik — rigour gate, signature panel, AI bar (DESIGN-SYSTEM §6.10–§6.13)
//
// These bind the core engine to the ux classes. The sign button's state and its
// explanation line come straight from assertGateS / the §5 error codes — the button
// is NEVER enabled without a reason shown, NEVER disabled without the reason shown
// (Principle 2, §6.12). No bare disabled button, ever.
// Ported from app/ui/panels.js (hyperscript → JSX); Shoprite classes unchanged.

import { useState } from "react";
import { Score, DocType, DocStatus } from "../core/enums";
import type { ScoreValue } from "../core/enums";
import { tally } from "../core/rigour";
import { assertGateS } from "../core/signing";
import { GateError } from "../core/errors";
import type { DuidelikDocument, RigourCheck, Signature, ActingUser, User } from "../types";
import type { AiClient } from "../core/aiClient";
import type { DocTypeValue } from "../core/enums";

const dotClass = (s: ScoreValue) =>
  s === Score.RED ? "dot dot--red" : s === Score.AMBER ? "dot dot--amber" : "dot dot--pass";

type ResolveUser = (id: string) => User | null;

// ── rigour gate ─────────────────────────────────────────────────────────────────
export function RigourGate({
  docType,
  checks,
  onOverride,
  onRunRigour,
  hasRun,
}: {
  docType: DocTypeValue;
  checks: RigourCheck[];
  onOverride: (check: RigourCheck, note: string) => void;
  onRunRigour: () => void;
  hasRun: boolean;
}) {
  const t = tally(checks);
  const total = checks.length || 1;
  const passFrac = Math.round((t.pass / total) * 100);
  const title = docType === DocType.BRD ? "Rigour gate — BRD" : "Rigour gate — FSD";
  const sub = docType === DocType.BRD ? "Must pass before the PO can sign" : "Must pass before sign-off to build";

  return (
    <div className="card rigour-gate">
      <div className="eyebrow eyebrow--muted">{title}</div>
      <div className="rigour-gate__sub">{sub}</div>
      {!hasRun ? (
        <div className="stack gap-3">
          <div className="rigour-gate__sub">Rigour has not been run yet.</div>
          <button className="btn btn--ghost btn--block" onClick={onRunRigour}>
            Run rigour
          </button>
        </div>
      ) : (
        <div>
          <div className="rigour-rows">
            {checks.map((c) => (
              <RigourRow key={c.key} check={c} onOverride={onOverride} />
            ))}
          </div>
          <div className="rigour-progress">
            <div className="rigour-progress__fill" style={{ width: passFrac + "%" }} />
          </div>
          <div className="rigour-tally">{`${t.pass} pass · ${t.amber} amber · ${t.red} red`}</div>
          <button className="btn btn--ghost btn--block mt-4" onClick={onRunRigour}>
            Re-run rigour
          </button>
        </div>
      )}
    </div>
  );
}

function RigourRow({ check, onOverride }: { check: RigourCheck; onOverride: (c: RigourCheck, note: string) => void }) {
  const [note, setNote] = useState(check.overrideNote || "");
  const qual = check.score === Score.AMBER ? " · amber" : check.score === Score.RED ? " · red" : "";
  return (
    <div>
      <div className="rigour-row">
        <span className={dotClass(check.score)}>●</span>
        <span>{labelFor(check.key)}</span>
        <span className="qual">{check.reason ? " · " + check.reason : qual}</span>
      </div>
      {check.score === Score.AMBER ? (
        <div className="override-note">
          <div className="override-note__label">⚠ Override note (required to accept amber)</div>
          <textarea
            placeholder="Explain why it's acceptable to proceed…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row gap-2" style={{ marginTop: "6px" }}>
            <button className="btn btn--ghost" disabled={!note.trim()} onClick={() => onOverride(check, note.trim())}>
              Accept amber
            </button>
          </div>
          <div className="override-note__hint">
            Recorded against your name &amp; this signature (RigourCheck.overrideNote).
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── signature panel (3 button states + signed record) ───────────────────────────
export function SignaturePanel({
  doc,
  checks,
  actingUser,
  onSign,
}: {
  doc: DuidelikDocument;
  checks: RigourCheck[];
  actingUser: ActingUser | null;
  onSign: () => void;
}) {
  if (doc.status === DocStatus.SIGNED || doc.status === DocStatus.PUBLISHED) {
    return null; // signed record is rendered by SignatureRecord
  }
  // compute GATE S state via the real enforcement path
  let state = "ready";
  let reason = "All checks pass — ready to sign.";
  let reasonCls = "sign-reason--pass";
  try {
    assertGateS(doc, checks, actingUser ?? undefined);
  } catch (e) {
    if (e instanceof GateError) {
      reason = e.message;
      reasonCls = "sign-reason--red";
      if (e.code === "ERR_AMBER_NEEDS_NOTE") {
        state = "amberblocked";
        reasonCls = "sign-reason--amber";
      } else if (e.code === "ERR_RED_BLOCKS" || e.code === "ERR_ROLE" || e.code === "ERR_NOT_IN_RIGOUR") {
        state = "blocked";
      }
    } else throw e;
  }
  // amber-ready: no red, amber all noted, role ok → the amber-gradient button
  const anyAmberNoted = checks.some((c) => c.score === Score.AMBER);
  if (state === "ready" && anyAmberNoted) {
    state = "amberready";
    reason = "No red items. Amber overridden with a note — ready to sign.";
    reasonCls = "sign-reason--amber";
  }

  const roleNote = doc.type === DocType.BRD ? " (PO only)" : "";
  const btn =
    state === "ready" ? (
      <button className="btn--sign" aria-describedby="sign-reason" onClick={onSign}>
        {`✓ Sign ${doc.type}${roleNote}`}
      </button>
    ) : state === "amberready" ? (
      <button className="btn--signamber" aria-describedby="sign-reason" onClick={onSign}>
        {`✎ Sign ${doc.type}${roleNote}`}
      </button>
    ) : (
      <button className="btn--signblocked" disabled aria-disabled="true" aria-describedby="sign-reason">
        {`🔒 Sign ${doc.type}${roleNote}`}
      </button>
    );

  return (
    <div className="card signature-panel">
      <div className="eyebrow eyebrow--muted">Signature</div>
      {btn}
      <div className={"sign-reason " + reasonCls} id="sign-reason">
        {reason}
      </div>
      <div className="sign-footnote">
        {doc.type === DocType.BRD
          ? "On sign, duidelik records who · when · against checklist brd-v1 and unlocks the FSD stage."
          : "On sign, duidelik records the approval and unlocks the QRG stage."}
      </div>
    </div>
  );
}

export function SignatureRecord({
  signature,
  resolveUser,
}: {
  signature: Signature | null;
  resolveUser: ResolveUser;
}) {
  if (!signature) return null;
  const who = resolveUser(signature.signedById);
  const when = new Date(signature.signedAt).toLocaleString();
  return (
    <div className="card signature-panel">
      <div className="eyebrow eyebrow--muted">Signature</div>
      <div className="signature-record">
        <div className="signature-record__who">
          <span className="lock">🔒 </span>
          {who ? who.name : signature.signedById}
          <span className="role">{" · " + roleLabel(signature.signedByRole)}</span>
        </div>
        <div className="signature-record__meta">
          {`Signed ${when} · against checklist ${signature.checklistVersion} · hash ${short(signature.documentHash)}`}
        </div>
      </div>
    </div>
  );
}

// ── AI co-author bar (online + offline) ─────────────────────────────────────────
export function AiBar({
  aiClient,
  docType,
  onDraft,
  busy,
}: {
  aiClient: AiClient | null;
  docType: DocTypeValue;
  status?: string;
  onDraft: () => void;
  busy?: boolean;
}) {
  const online = !!(aiClient && aiClient.isAvailable && aiClient.isAvailable());
  if (!online) {
    return (
      <div className="ai-bar ai-bar--offline">
        <div className="ai-bar__head">
          <span className="glyph">✦</span> AI CO-AUTHOR <span className="ctx">· unavailable</span>
        </div>
        <div className="ai-bar__msg">
          AI co-author unavailable — deterministic checks only. You can still edit, run rigour, and sign.
        </div>
      </div>
    );
  }
  const ctx =
    docType === DocType.FSD
      ? "· drafting from signed BRD"
      : docType === DocType.QRG
        ? "· QRG mode — drafting from signed FSD"
        : "· drafting from the one-liner";
  return (
    <div className="ai-bar">
      <div className="ai-bar__head">
        <span className="glyph">✦</span> AI CO-AUTHOR <span className="ctx">{ctx}</span>
      </div>
      <div className="ai-bar__msg">
        {busy ? "Drafting…" : `Let me draft this ${docType} for you to edit. I never sign — you do.`}
      </div>
      <div className="ai-bar__actions">
        <button className="btn btn--ai" disabled={busy} onClick={onDraft}>
          {`✦ Draft ${docType}`}
        </button>
        <button className="btn btn--ghost" disabled={busy}>
          Let me write it
        </button>
      </div>
    </div>
  );
}

// ── label helpers (content owns real wording; these are safe fallbacks) ──
const LABELS: Record<string, string> = {
  "brd.decision_stated": "Decision stated",
  "brd.single_owner": "Single owner",
  "brd.measurable_success": "Measurable success",
  "brd.scope_boundary": "Scope boundary",
  "brd.domain_placement": "Domain placement",
  "brd.source_clarity": "Source clarity",
  "fsd.traceable_to_brd": "Traceable to BRD",
  "fsd.data_model_present": "Data model present",
  "fsd.erd_attached": "ERD attached",
  "fsd.grain_stated": "Grain stated",
  "fsd.nonfunctionals": "Non-functionals",
};
function labelFor(key: string): string {
  return LABELS[key] || key;
}
function roleLabel(role: string): string {
  return (
    (
      {
        PRODUCT_OWNER: "Product Owner",
        PRODUCT_MANAGER: "Product Manager",
        BUSINESS_ANALYST: "Business Analyst",
        FUNCTIONAL_ANALYST: "Functional Analyst",
      } as Record<string, string>
    )[role] || role
  );
}
function short(hash: string): string {
  return (hash || "").slice(0, 14);
}
