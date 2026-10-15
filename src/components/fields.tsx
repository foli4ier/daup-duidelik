// duidelik — generic doc-section field editors (schema-driven)
//
// Walks docSchemas.sectionsFor(docType) and renders each field by its `kind`. Every
// editor is CONTROLLED by the document's content and emits an onChange(nextContent)
// so the Product screen can dispatch EDIT_DOCUMENT (which drops the doc to DRAFT and
// cascades if it was SIGNED). Classes are DESIGN-SYSTEM §6.9 — no inline restyle.
//
// Field-callouts colour by the rigour result for the section's rigourKey, so the
// human sees WHY an item is amber/red at the point of editing (§6.9).
// Ported from app/ui/fields.js (hyperscript → JSX).

import { Score } from "../core/enums";
import type { SectionSchema, FieldSchema } from "./docSchemas";
import type { RigourCheck, User, DataProduct, DocContent } from "../types";

type AnyRec = Record<string, any>;

interface FieldCtx {
  product?: DataProduct;
  users: User[];
  placementPath?: string;
  signedBrdKeys?: string[];
}

// ── per-field editors ──────────────────────────────────────────────────────────
function Text({ value, onChange, placeholder }: { value?: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="field__input"
      value={value || ""}
      placeholder={placeholder || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
function TextArea({ value, onChange, placeholder }: { value?: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <textarea
      className="field__textarea"
      value={value || ""}
      placeholder={placeholder || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function StringList({ value, onChange, placeholder }: { value?: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((it, i) => (
        <div className="row gap-2" key={i}>
          <input
            className="field__input"
            style={{ flex: 1 }}
            value={it}
            onChange={(e) => onChange(replace(items, i, e.target.value))}
          />
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))} aria-label="remove">
            ×
          </button>
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, ""])}>
        {placeholder || "+ Add"}
      </button>
    </div>
  );
}

function MetricList({ value, onChange }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((m, i) => (
        <div className="row gap-2" key={i} style={{ flexWrap: "wrap" }}>
          <input className="field__input" placeholder="metric" style={{ flex: "2 1 160px" }} value={m.metric || ""}
            onChange={(e) => onChange(replace(items, i, { ...m, metric: e.target.value }))} />
          <input className="field__input" placeholder="baseline" style={{ flex: "1 1 90px" }} value={m.baseline || ""}
            onChange={(e) => onChange(replace(items, i, { ...m, baseline: e.target.value }))} />
          <input className="field__input" placeholder="target (needs a number)" style={{ flex: "1 1 120px" }} value={m.target || ""}
            onChange={(e) => onChange(replace(items, i, { ...m, target: e.target.value }))} />
          <input className="field__input" placeholder="by" style={{ flex: "0 1 90px" }} value={m.by || ""}
            onChange={(e) => onChange(replace(items, i, { ...m, by: e.target.value }))} />
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, { metric: "", target: "" }])}>
        + Add metric
      </button>
    </div>
  );
}

function SourceList({ value, onChange }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((s, i) => (
        <div className="row gap-2" key={i} style={{ flexWrap: "wrap" }}>
          <input className="field__input" placeholder="named system" style={{ flex: "2 1 180px" }} value={s.name || ""}
            onChange={(e) => onChange(replace(items, i, { ...s, name: e.target.value }))} />
          <input className="field__input" placeholder="type" style={{ flex: "1 1 90px" }} value={s.type || ""}
            onChange={(e) => onChange(replace(items, i, { ...s, type: e.target.value }))} />
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, { name: "" }])}>
        + Add source
      </button>
    </div>
  );
}

function OwnerPicker({ value, onChange, users }: { value?: string | null; onChange: (v: string | null) => void; users: User[] }) {
  const pos = users.filter((u) => u.role === "PRODUCT_OWNER");
  return (
    <select className="field__select" value={value || ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— choose a Product Owner —</option>
      {pos.map((u) => (
        <option value={u.id} key={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

function RequirementList({ value, onChange, brdKeys }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void; brdKeys?: string[] }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((r, i) => (
        <div className="row gap-2" key={i} style={{ flexWrap: "wrap" }}>
          <input className="field__input" placeholder="FR-1" style={{ flex: "0 1 70px" }} value={r.id || ""}
            onChange={(e) => onChange(replace(items, i, { ...r, id: e.target.value }))} />
          <input className="field__input" placeholder="requirement text" style={{ flex: "2 1 220px" }} value={r.text || ""}
            onChange={(e) => onChange(replace(items, i, { ...r, text: e.target.value }))} />
          <select className="field__select" style={{ flex: "1 1 140px" }} value={r.brdRef || ""}
            onChange={(e) => onChange(replace(items, i, { ...r, brdRef: e.target.value || null }))}>
            <option value="">— brdRef —</option>
            {(brdKeys || []).map((k) => (
              <option value={k} key={k}>
                {k}
              </option>
            ))}
          </select>
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
        </div>
      ))}
      <button className="btn btn--ghost"
        onClick={() => onChange([...items, { id: `FR-${items.length + 1}`, text: "", brdRef: null }])}>
        + Add requirement
      </button>
      {brdKeys && brdKeys.length === 0 ? (
        <div className="rigour-gate__sub">No signed-BRD keys available — sign the BRD first.</div>
      ) : null}
    </div>
  );
}

function EntityList({ value, onChange }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((en, i) => (
        <div className="card card--subtle" key={i}>
          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            <input className="field__input" placeholder="entity name" style={{ flex: "2 1 160px" }} value={en.name || ""}
              onChange={(e) => onChange(replace(items, i, { ...en, name: e.target.value }))} />
            <input className="field__input" placeholder="kind (fact/dimension)" style={{ flex: "1 1 120px" }} value={en.kind || ""}
              onChange={(e) => onChange(replace(items, i, { ...en, kind: e.target.value }))} />
            <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
          </div>
          <input className="field__input mt-4" placeholder='grain — "one row per …"' value={en.grain || ""}
            onChange={(e) => onChange(replace(items, i, { ...en, grain: e.target.value }))} />
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, { name: "", grain: "", relationships: [] }])}>
        + Add entity
      </button>
    </div>
  );
}

function ErdEditor({ value, onChange }: { value?: AnyRec; onChange: (v: AnyRec) => void }) {
  const erd = value || { format: "mermaid", source: "", generatedByAi: false };
  const empty = !(erd.source && erd.source.trim());
  return (
    <div className="stack gap-2">
      <div className={empty ? "erd-canvas erd-canvas--empty" : "erd-canvas"}>
        {empty ? (
          "No ERD yet — AI can generate one from the data model."
        ) : (
          <pre style={{ color: "var(--a)", textAlign: "left", whiteSpace: "pre-wrap" }}>{erd.source}</pre>
        )}
      </div>
      <div className="row gap-2">
        <select className="field__select" value={erd.format || "mermaid"} style={{ flex: "0 1 120px" }}
          onChange={(e) => onChange({ ...erd, format: e.target.value })}>
          {["mermaid", "svg", "dbml"].map((f) => (
            <option value={f} key={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <textarea className="field__textarea"
        placeholder="ERD source (mermaid / svg / dbml) — or let the AI co-author generate it"
        value={erd.source || ""} onChange={(e) => onChange({ ...erd, source: e.target.value })} />
    </div>
  );
}

function NfrEditor({ value, onChange }: { value?: AnyRec; onChange: (v: AnyRec) => void }) {
  const nf = value || {};
  const tile = (k: string, label: string) => (
    <div className="nfr-tile" key={k}>
      <span className="nfr-tile__label">{label}</span>
      <input className="field__input" value={nf[k] || ""} onChange={(e) => onChange({ ...nf, [k]: e.target.value })} />
    </div>
  );
  return (
    <div className="nfr-grid">
      {tile("refresh", "Refresh")}
      {tile("retention", "Retention")}
      {tile("access", "Access")}
    </div>
  );
}

function UseCaseList({ value, onChange }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((u, i) => (
        <div className="row gap-2" key={i} style={{ flexWrap: "wrap" }}>
          <input className="field__input" placeholder="question" style={{ flex: "1 1 180px" }} value={u.question || ""}
            onChange={(e) => onChange(replace(items, i, { ...u, question: e.target.value }))} />
          <input className="field__input" placeholder="how to use" style={{ flex: "1 1 180px" }} value={u.howToUse || ""}
            onChange={(e) => onChange(replace(items, i, { ...u, howToUse: e.target.value }))} />
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, { question: "", howToUse: "" }])}>
        + Add use case
      </button>
    </div>
  );
}

function KeyFieldList({ value, onChange }: { value?: AnyRec[]; onChange: (v: AnyRec[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="stack gap-2">
      {items.map((k, i) => (
        <div className="row gap-2" key={i} style={{ flexWrap: "wrap" }}>
          <input className="field__input" placeholder="field name" style={{ flex: "1 1 120px" }} value={k.name || ""}
            onChange={(e) => onChange(replace(items, i, { ...k, name: e.target.value }))} />
          <input className="field__input" placeholder="meaning" style={{ flex: "2 1 180px" }} value={k.meaning || ""}
            onChange={(e) => onChange(replace(items, i, { ...k, meaning: e.target.value }))} />
          <button className="btn btn--ghost" onClick={() => onChange(removeAt(items, i))}>×</button>
        </div>
      ))}
      <button className="btn btn--ghost" onClick={() => onChange([...items, { name: "", meaning: "" }])}>
        + Add field
      </button>
    </div>
  );
}

// ── field dispatcher ─────────────────────────────────────────────────────────
function Field({ field, content, onPatch, ctx }: { field: FieldSchema; content: DocContent; onPatch: (c: DocContent) => void; ctx: FieldCtx }) {
  const c = content as AnyRec;
  const value = c[field.key];
  const set = (v: unknown) => onPatch({ ...content, [field.key]: v });

  switch (field.kind) {
    case "readonly-oneliner":
      return <div className="doc-section__value">{`"${ctx.product?.oneLiner || ""}"`}</div>;
    case "readonly-breadcrumb":
      return <div className="doc-section__value">{ctx.placementPath || "—"}</div>;
    case "text":
      return <Text value={value} onChange={set} />;
    case "textarea":
      return <TextArea value={value} onChange={set} placeholder={field.hint} />;
    case "string-list":
      return <StringList value={value} onChange={set} placeholder={`+ Add ${field.label.toLowerCase()}`} />;
    case "metric-list":
      return <MetricList value={value} onChange={set} />;
    case "source-list":
      return <SourceList value={value} onChange={set} />;
    case "owner-picker":
      return <OwnerPicker value={value} onChange={set} users={ctx.users} />;
    case "requirement-list":
      return <RequirementList value={value} onChange={set} brdKeys={ctx.signedBrdKeys} />;
    case "entity-list":
      return <EntityList value={value} onChange={set} />;
    case "erd":
      return <ErdEditor value={value} onChange={set} />;
    case "nfr":
      return <NfrEditor value={value} onChange={set} />;
    case "usecase-list":
      return <UseCaseList value={value} onChange={set} />;
    case "keyfield-list":
      return <KeyFieldList value={value} onChange={set} />;
    case "glossary-link-list":
      return <StringList value={value} onChange={set} placeholder="+ Add glossary term id" />;
    case "related-link-list":
      return (
        <StringList
          value={(value || []).map((l: AnyRec) => l.label)}
          onChange={(labels) => set(labels.map((label) => ({ label, url: null })))}
          placeholder="+ Add link label"
        />
      );
    default:
      return <div className="doc-section__value">{JSON.stringify(value ?? null)}</div>;
  }
}

// ── section (label + its fields + rigour callout) ───────────────────────────────
export function DocSection({
  section,
  content,
  onPatch,
  ctx,
  check,
}: {
  section: SectionSchema;
  content: DocContent;
  onPatch: (c: DocContent) => void;
  ctx: FieldCtx;
  check?: RigourCheck | null;
}) {
  const callClass =
    check && check.score === Score.RED
      ? "field-callout field-callout--red"
      : check && check.score === Score.AMBER
        ? "field-callout field-callout--amber"
        : null;
  const glyph = check && check.score === Score.RED ? " ⛔" : check && check.score === Score.AMBER ? " ⚠" : "";

  return (
    <div className="doc-section">
      <div className="doc-section__label">
        {section.label + (section.rigourKey && check ? ` · ${check.score}${glyph}` : "")}
      </div>
      <div className="stack gap-3" style={{ marginTop: "6px" }}>
        {section.fields.map((f) => (
          <div className="field" key={f.key}>
            <label className="field__label">
              {f.kind !== "readonly-oneliner" && f.kind !== "readonly-breadcrumb"
                ? f.label + (f.optional ? " (optional)" : "")
                : f.label}
            </label>
            <Field field={f} content={content} onPatch={onPatch} ctx={ctx} />
          </div>
        ))}
      </div>
      {callClass && check && check.reason ? (
        <div className={callClass} style={{ marginTop: "8px" }}>
          {check.reason}
        </div>
      ) : null}
    </div>
  );
}

// ── helpers ──
function replace<T>(arr: T[], i: number, v: T): T[] {
  const c = arr.slice();
  c[i] = v;
  return c;
}
function removeAt<T>(arr: T[], i: number): T[] {
  const c = arr.slice();
  c.splice(i, 1);
  return c;
}
