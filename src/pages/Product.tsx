// duidelik — Product screen (lifecycle view): the §7 product-lifecycle + FSD layouts,
// plus QRG and Glossary tabs. Everything mutates via store.dispatch — never direct.
// Ported from app/ui/Product.js (hyperscript → JSX).

import { Fragment, useState } from "react";
import { LifecycleStage, DocStatus, DocType } from "../core/enums";
import type { DocTypeValue } from "../core/enums";
import { sectionsFor } from "../components/docSchemas";
import { DocSection } from "../components/fields";
import { RigourGate, SignaturePanel, SignatureRecord, AiBar } from "../components/panels";
import { LifecycleRail } from "../components/LifecycleRail";
import {
  buildDocumentArtifact,
  buildGlossaryArtifact,
  artifactJson,
  artifactFilename,
  parseArtifact,
  productMismatchReason,
  isDocumentArtifact,
  docTypeOf,
  ArtifactError,
} from "../core/artifact";
import { downloadTextFile, pickTextFile } from "../api/fileIo";
import { buildOpenInProjectUrl } from "../api/projectLink";
import { useSession } from "../context/SessionContext";
import type { Store, Intent, DispatchResult } from "../core/store";
import type { StoreGraph, DataProduct, DuidelikDocument, Signature, DocContent, RigourCheck, RoadmapItem, RoadmapColumn } from "../types";
import type { AiClient } from "../core/aiClient";

type TabKey = DocTypeValue | "GLOSSARY" | "ROADMAP";
const TABS: TabKey[] = [DocType.BRD, DocType.FSD, DocType.QRG, "GLOSSARY", "ROADMAP"];

type DocFor = (type: DocTypeValue) => DuidelikDocument | null;
type DispatchFn = (intent: Intent) => Promise<DispatchResult>;

export function ProductScreen({
  store,
  state,
  productId,
  onBack,
  onOpenProduct,
  aiClient,
}: {
  store: Store;
  state: StoreGraph;
  productId: string;
  onBack: () => void;
  onOpenProduct: (id: string) => void;
  aiClient: AiClient | null;
}) {
  const product = store.product(productId);
  const [tab, setTab] = useState<TabKey>(DocType.BRD);
  const [banner, setBanner] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  // Runtime AI reachability. Starts optimistic (a transport is wired) and flips false
  // the first time a draft call fails — e.g. the P5 /ai/* route isn't built in local
  // dev, so the fetch 404s. The AI bar then shows its offline state instead of a dead
  // Draft button (DESIGN-SYSTEM §6.10 / STACK §4 graceful degradation).
  const [aiReachable, setAiReachable] = useState(true);

  if (!product)
    return (
      <div className="screen__body">
        Product not found.{" "}
        <a href="#" onClick={onBack}>
          back
        </a>
      </div>
    );

  const docFor: DocFor = (type) => store.docOf(productId, type);
  const resolveUser = store.resolveUser;
  const actingUser = store.actingUser();
  const owner = product.ownerId ? resolveUser(product.ownerId) : null;
  const placementPath = pathFor(state, product);

  const dispatch: DispatchFn = async (intent) => {
    const res = (await store.dispatch(intent)) as DispatchResult;
    if (res && (res as any).invalidation) setBanner((res as any).invalidation.banner);
    if (res && res.ok === false) setBanner(res.message || res.code || null);
    return res;
  };

  return (
    <div className="screen du-root">
      <div className="brand-strip" />
      <div className="screen__body">
        <div className="breadcrumb">{placementPath}</div>
        <div className="row row--between row--end" style={{ marginTop: "6px" }}>
          <div>
            <div className="meta">{`${product.code} · Owner: ${owner ? owner.name : "—"}`}</div>
            <h1 className="h1">{product.name}</h1>
          </div>
          <button className="btn btn--ghost" onClick={onBack}>
            ← Registry
          </button>
        </div>

        <div className="mt-6">
          <LifecycleRail product={product} docFor={docFor} invalidatedBanner={banner} />
        </div>

        <div className="product-tabs" role="tablist">
          {TABS.map((t) => (
            <span
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={"product-tab" + (tab === t ? " product-tab--active" : "")}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
            </span>
          ))}
        </div>

        <div className="mt-4">
          {tab === "GLOSSARY" ? (
            <GlossaryTab store={store} state={state} productId={productId} />
          ) : tab === "ROADMAP" ? (
            <RoadmapTab store={store} state={state} productId={productId} onOpenProduct={onOpenProduct} />
          ) : (
            <DocTab
              store={store}
              state={state}
              product={product}
              docType={tab}
              docFor={docFor}
              resolveUser={resolveUser}
              actingUser={actingUser}
              placementPath={placementPath}
              aiClient={aiClient}
              aiBusy={aiBusy}
              setAiBusy={setAiBusy}
              aiReachable={aiReachable}
              setAiReachable={setAiReachable}
              dispatch={dispatch}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DocTab({
  store,
  state,
  product,
  docType,
  docFor,
  resolveUser,
  actingUser,
  placementPath,
  aiClient,
  aiBusy,
  setAiBusy,
  aiReachable,
  setAiReachable,
  dispatch,
}: {
  store: Store;
  state: StoreGraph;
  product: DataProduct;
  docType: DocTypeValue;
  docFor: DocFor;
  resolveUser: (id: string) => any;
  actingUser: any;
  placementPath: string;
  aiClient: AiClient | null;
  aiBusy: boolean;
  setAiBusy: (b: boolean) => void;
  aiReachable: boolean;
  setAiReachable: (b: boolean) => void;
  dispatch: DispatchFn;
}) {
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const isOwner = store.isPO();
  const doc = docFor(docType);

  // Import a document artifact for this product/doc-type. Shared by the doc-shell
  // header and the create panel (import-to-create). Validates kind + product match,
  // confirms a signed overwrite, then routes through IMPORT_DOCUMENT (→ EDIT_DOCUMENT,
  // so a signed target re-opens to DRAFT — never a forged signature).
  async function importDocumentFlow(existing: DuidelikDocument | null) {
    let text: string | null;
    try {
      text = await pickTextFile();
    } catch {
      setImportMsg("Could not read the selected file.");
      return;
    }
    if (text == null) return; // cancelled
    let art;
    try {
      art = parseArtifact(text);
    } catch (e) {
      setImportMsg(e instanceof ArtifactError ? e.message : "This file is not a valid duidelik artifact.");
      return;
    }
    if (!isDocumentArtifact(art)) {
      setImportMsg(`That file is a ${art.kind} artifact — open the Glossary tab to import it.`);
      return;
    }
    if (art.kind !== docType) {
      setImportMsg(`That file is a ${art.kind}; you are on the ${docType} tab. Open the ${art.kind} tab to import it.`);
      return;
    }
    const mismatch = productMismatchReason(art, product);
    if (mismatch && !window.confirm(mismatch + "\n\nImport anyway?")) return;
    if (existing && existing.status === DocStatus.SIGNED) {
      if (
        !window.confirm(
          `This ${docType} is SIGNED. Importing re-opens it to DRAFT and invalidates the signature (the old signature stays on record as historical). Continue?`,
        )
      )
        return;
    }
    const res = (await dispatch({
      type: "IMPORT_DOCUMENT",
      productId: product.id,
      docType: docTypeOf(art),
      content: art.document.content,
    })) as DispatchResult;
    if (res.ok) {
      setImportMsg(
        `Imported ${docType} from file.${existing && existing.status === DocStatus.SIGNED ? " Re-run rigour and re-sign." : ""}`,
      );
    } else {
      setImportMsg(res.message || res.code || "Import failed.");
    }
  }

  if (!doc)
    return (
      <CreateDocPanel
        product={product}
        docType={docType}
        docFor={docFor}
        dispatch={dispatch}
        onImport={() => importDocumentFlow(null)}
        importMsg={importMsg}
      />
    );

  const checks = store.checksForDoc(doc.id);
  const hasRun = doc.status !== DocStatus.DRAFT || checks.length > 0;
  const sections = sectionsFor(docType);
  const checkByKey = Object.fromEntries(checks.map((c) => [c.key, c]));
  const signature = latestSignature(state, doc.id);
  const signedBrd = docFor(DocType.BRD);
  const signedBrdKeys = signedBrd && signedBrd.status === DocStatus.SIGNED ? Object.keys(signedBrd.content || {}) : [];
  const ctx = {
    product,
    // The owner-picker's PO candidates: the roster's Product Owners in house mode, the
    // seeded POs in standalone. (In standalone this is the same population as before,
    // since OwnerPicker already filtered users to PRODUCT_OWNER.)
    users: store.ownerCandidates(),
    placementPath,
    signedBrdKeys,
    onEditOneLiner: (next: string) => dispatch({ type: "EDIT_ONELINER", productId: product.id, oneLiner: next }),
  };

  const patch = (nextContent: DocContent) => dispatch({ type: "EDIT_DOCUMENT", documentId: doc.id, content: nextContent });

  async function draft() {
    if (!aiClient || !aiClient.isAvailable() || !aiReachable) return;
    setAiBusy(true);
    try {
      const content = await aiClient.draft(docType, product, { current: doc!.content });
      await dispatch({ type: "EDIT_DOCUMENT", documentId: doc!.id, content });
    } catch {
      // The transport is wired but the call failed (route down / unreachable / timeout).
      // Flip reachability so the AI bar renders its offline state and the Draft button
      // stops being a dead click (DESIGN-SYSTEM §6.10). The app is never blocked on AI:
      // the human edits by hand and rigour runs deterministically (STACK §4).
      setAiReachable(false);
    } finally {
      setAiBusy(false);
    }
  }

  async function runRigour() {
    if (doc!.status === DocStatus.DRAFT) await dispatch({ type: "START_RIGOUR", documentId: doc!.id });
    await dispatch({ type: "RUN_RIGOUR", documentId: doc!.id });
  }
  async function sign() {
    return dispatch({ type: "SIGN", documentId: doc!.id });
  }

  // ── per-artifact export / import (file round-trip for SharePoint; core/artifact.ts) ──
  function exportArtifact() {
    const sig = store.signatureForDoc(doc!.id);
    const art = buildDocumentArtifact(doc!, sig, {
      product,
      placement: placementPath,
      placeId: null, // placeId scopes the store key (per-place); header carries display context only
      resolveUserName: (id) => resolveUser(id)?.name || id,
    });
    downloadTextFile(artifactFilename(art), artifactJson(art));
  }

  async function unlock() {
    if (
      !window.confirm(
        `Unlock this signed ${docType} for editing? The signature is invalidated (kept on record as historical) and the document returns to DRAFT. Any downstream document is pulled back too.`,
      )
    )
      return;
    const res = (await dispatch({ type: "UNLOCK_DOCUMENT", documentId: doc!.id })) as DispatchResult;
    if (!res.ok) setImportMsg(res.message || res.code || "Unlock failed.");
  }

  const centre = (
    <div className="doc-shell">
      <div className="doc-shell__head">
        <div className="eyebrow eyebrow--teal">{`${docTypeTitle(docType)} · ${doc.status}`}</div>
        <div className="row gap-3" style={{ alignItems: "center" }}>
          <button
            className="btn btn--ghost"
            title={`Export this ${docType} as a JSON file (save it to SharePoint)`}
            onClick={exportArtifact}
          >
            ⭳ Export
          </button>
          <button
            className="btn btn--ghost"
            title={`Import a ${docType} from a JSON file (e.g. downloaded from SharePoint)`}
            onClick={() => importDocumentFlow(doc)}
          >
            ⭱ Import
          </button>
          <button
            className="btn btn--ghost"
            title={`Print this ${docType}`}
            onClick={() => printDocument({ docType, doc, product, placementPath, signature, resolveUser, checks })}
          >
            🖨 Print
          </button>
          <div className="doc-shell__head-meta">{signature ? <span className="hl">signed</span> : "editable"}</div>
        </div>
      </div>
      {importMsg ? (
        <div className="rigour-gate__sub" style={{ padding: "0 16px", color: "var(--a)" }}>
          {importMsg}
        </div>
      ) : null}
      <div className="doc-shell__body">
        {sections.map((s) => (
          <DocSection
            key={s.id}
            section={s}
            content={doc.content || {}}
            onPatch={patch}
            ctx={ctx}
            check={s.rigourKey ? checkByKey[s.rigourKey] : null}
          />
        ))}
      </div>
      <AiBar aiClient={aiClient} docType={docType} status={doc.status} busy={aiBusy} online={aiReachable} onDraft={() => draft()} />
    </div>
  );

  const right =
    docType === DocType.QRG ? (
      <QrgPublishPanel doc={doc} dispatch={dispatch} productId={product.id} />
    ) : (
      <div className="stack gap-4">
        {signature && doc.status === DocStatus.SIGNED ? (
          <Fragment>
            <SignatureRecord signature={signature} resolveUser={resolveUser} />
            <div className="card card--dashed" style={{ fontSize: ".76rem", color: "var(--label)", lineHeight: 1.5 }}>
              <div className="eyebrow eyebrow--muted" style={{ marginBottom: "8px" }}>
                Owner controls
              </div>
              {isOwner ? (
                <Fragment>
                  <button className="btn btn--ghost btn--block" onClick={unlock}>
                    🔓 Unlock to edit
                  </button>
                  <div style={{ marginTop: "8px" }}>
                    Re-opens this signed {docType} to DRAFT for editing. The signature is kept on record as
                    historical and marked stale; any downstream document is pulled back and must be re-signed
                    (invalidation cascade).
                  </div>
                </Fragment>
              ) : (
                <div>Only a Product Owner can unlock a signed document.</div>
              )}
            </div>
          </Fragment>
        ) : (
          <Fragment>
            <RigourGate
              docType={docType}
              checks={checks}
              hasRun={hasRun}
              onRunRigour={() => runRigour()}
              onOverride={(check, note) => dispatch({ type: "APPLY_OVERRIDE", checkId: check.id!, note })}
            />
            <SignaturePanel doc={doc} checks={checks} actingUser={actingUser} onSign={() => sign()} />
          </Fragment>
        )}
      </div>
    );

  return (
    <div className="work-area" style={{ display: "grid", gridTemplateColumns: "1.55fr .95fr", gap: "16px" }}>
      {centre}
      {right}
    </div>
  );
}

function CreateDocPanel({
  product,
  docType,
  docFor,
  dispatch,
  onImport,
  importMsg,
}: {
  product: DataProduct;
  docType: DocTypeValue;
  docFor: DocFor;
  dispatch: DispatchFn;
  onImport: () => void;
  importMsg: string | null;
}) {
  let can = true;
  let why = "";
  if (docType === DocType.BRD) {
    can = product.stage === LifecycleStage.ONE_LINER;
    why = can
      ? "Create the BRD to start the lifecycle (AI can draft it from the one-liner)."
      : "BRD already exists or product has advanced.";
  } else if (docType === DocType.FSD) {
    const brd = docFor(DocType.BRD);
    can = !!brd && brd.status === DocStatus.SIGNED && product.stage === LifecycleStage.BRD;
    why = can ? "BRD is signed — create the FSD." : "🔒 Locked: the BRD must be SIGNED before an FSD can be created (hard gate).";
  } else if (docType === DocType.QRG) {
    const fsd = docFor(DocType.FSD);
    can = !!fsd && fsd.status === DocStatus.SIGNED && product.stage === LifecycleStage.FSD;
    why = can ? "FSD is signed — create the QRG." : "🔒 Locked: the FSD must be SIGNED before a QRG can be created.";
  }
  const intent = { [DocType.BRD]: "CREATE_BRD", [DocType.FSD]: "CREATE_FSD", [DocType.QRG]: "CREATE_QRG" }[docType] as Intent["type"];
  return (
    <div className="card card--dashed" style={{ textAlign: "center" }}>
      <div className="rigour-gate__sub" style={{ marginBottom: "12px" }}>
        {why}
      </div>
      <div className="row gap-3" style={{ justifyContent: "center" }}>
        {can ? (
          <button className="btn btn--primary" onClick={() => dispatch({ type: intent, productId: product.id } as Intent)}>
            {`+ Create ${docType}`}
          </button>
        ) : null}
        {can ? (
          <button
            className="btn btn--ghost"
            title={`Import a ${docType} from a JSON file (e.g. from SharePoint)`}
            onClick={onImport}
          >
            ⭱ Import {docType} from file
          </button>
        ) : null}
      </div>
      {importMsg ? (
        <div className="rigour-gate__sub" style={{ marginTop: "10px", color: "var(--a)" }}>
          {importMsg}
        </div>
      ) : null}
    </div>
  );
}

function QrgPublishPanel({ doc, dispatch, productId }: { doc: DuidelikDocument; dispatch: DispatchFn; productId: string }) {
  if (doc.status === DocStatus.PUBLISHED) {
    return (
      <div className="card signature-panel">
        <div className="eyebrow eyebrow--muted">Published</div>
        <div className="sign-reason sign-reason--pass">✓ QRG published — product is LIVE.</div>
      </div>
    );
  }
  const canPublish = !!(doc.content && ((doc.content as any).summary || "").trim());
  return (
    <div className="stack gap-4">
      <div className="card card--dashed" style={{ fontSize: ".78rem", color: "var(--label)" }}>
        <div className="eyebrow eyebrow--muted" style={{ marginBottom: "8px" }}>
          Rigour gate — QRG
        </div>
        No rigour checklist for the QRG in v1 — it is a usage guide, not a sign-off document.
      </div>
      <div className="card signature-panel">
        <div className="eyebrow eyebrow--muted">Publish</div>
        {canPublish ? (
          <button className="btn--sign" onClick={() => dispatch({ type: "PUBLISH_QRG", productId })}>
            ✓ Publish QRG
          </button>
        ) : (
          <button className="btn--signblocked" disabled aria-disabled="true">
            🔒 Publish QRG
          </button>
        )}
        <div className={"sign-reason " + (canPublish ? "sign-reason--pass" : "sign-reason--amber")}>
          {canPublish
            ? "Publishing makes the guide live and moves the product to LIVE."
            : "Add a summary — it is the one field required to publish."}
        </div>
      </div>
    </div>
  );
}

function GlossaryTab({ store, state, productId }: { store: Store; state: StoreGraph; productId: string }) {
  const [term, setTerm] = useState("");
  const [def, setDef] = useState("");
  const [warn, setWarn] = useState<string | null>(null);
  const product = store.product(productId)!;
  const terms = state.glossaryTerms
    .filter((t) => t.dataProductId === productId)
    .sort((a, b) => a.term.localeCompare(b.term));

  const add = async () => {
    const res = (await store.dispatch({ type: "ADD_GLOSSARY_TERM", productId, term, definition: def })) as any;
    if (res.ok) {
      setTerm("");
      setDef("");
      setWarn(res.duplicateWarning ? `Note: "${res.term.term}" duplicates an existing term.` : null);
    } else setWarn(res.message);
  };

  const exportGlossary = () => {
    const art = buildGlossaryArtifact(store.glossaryForProduct(productId), {
      product,
      placement: pathFor(state, product),
      placeId: null,
      resolveUserName: (id) => store.resolveUser(id)?.name || id,
    });
    downloadTextFile(artifactFilename(art), artifactJson(art));
  };

  const importGlossary = async () => {
    let text: string | null;
    try {
      text = await pickTextFile();
    } catch {
      setWarn("Could not read the selected file.");
      return;
    }
    if (text == null) return;
    let art;
    try {
      art = parseArtifact(text);
    } catch (e) {
      setWarn(e instanceof ArtifactError ? e.message : "This file is not a valid duidelik artifact.");
      return;
    }
    if (art.kind !== "GLOSSARY") {
      setWarn(`That file is a ${art.kind} artifact — import it from the ${art.kind} tab, not the Glossary.`);
      return;
    }
    const mismatch = productMismatchReason(art, product);
    if (mismatch && !window.confirm(mismatch + "\n\nImport anyway?")) return;
    const res = (await store.dispatch({ type: "IMPORT_GLOSSARY", productId, terms: art.terms })) as any;
    if (res.ok) setWarn(`Imported glossary: ${res.added} added, ${res.updated} updated.`);
    else setWarn(res.message || "Import failed.");
  };

  return (
    <div className="card" style={{ borderTopLeftRadius: 0 }}>
      <div className="row row--between" style={{ marginBottom: "14px" }}>
        <div>
          <div className="eyebrow eyebrow--teal">{`Glossary — ${terms.length} term${terms.length === 1 ? "" : "s"}`}</div>
          <div className="rigour-gate__sub" style={{ margin: "4px 0 0" }}>
            Plain-language definitions scoped to this product. Editable at any stage — no gate.
          </div>
        </div>
        <div className="row gap-3">
          <button className="btn btn--ghost" title="Export the glossary as a JSON file (save it to SharePoint)" onClick={exportGlossary}>
            ⭳ Export
          </button>
          <button className="btn btn--ghost" title="Import glossary terms from a JSON file (merges by term)" onClick={importGlossary}>
            ⭱ Import
          </button>
        </div>
      </div>
      <div className="card card--subtle" style={{ marginBottom: "14px" }}>
        <div className="row gap-4" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 180px" }}>
            <label className="field__label">Term</label>
            <input className="field__input" value={term} onChange={(e) => setTerm(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "3 1 320px" }}>
            <label className="field__label">Definition</label>
            <input className="field__input" value={def} onChange={(e) => setDef(e.target.value)} />
          </div>
          <button className="btn btn--ai" disabled={!term.trim() || !def.trim()} onClick={add}>
            Save term
          </button>
        </div>
        {warn ? (
          <div className="rigour-gate__sub" style={{ marginTop: "8px", color: "var(--amber)" }}>
            {warn}
          </div>
        ) : null}
      </div>
      <div className="glossary-list">
        {terms.length === 0 ? (
          <div className="rigour-gate__sub">No terms yet.</div>
        ) : (
          terms.map((t) => (
            <div className="glossary-term" key={t.id}>
              <div className="glossary-term__term">{t.term}</div>
              <div className="glossary-term__def">{t.definition}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Roadmap tab ──────────────────────────────────────────────────────────────
// A per-product kanban: three columns (Current / Planned / Future) of project tiles.
// Each tile may link to another registry DataProduct (one source of truth). Authoring
// is ungated (like the glossary) and never touches document status / rigour / signing.
// The daup-projects integration + the Gantt project-plan editor are a DEFERRED, scoped
// piece — a tile carries a daupProjectRef seam but nothing opens daup-projects yet.
const ROADMAP_COLUMNS: { key: RoadmapColumn; label: string; hint: string }[] = [
  { key: "CURRENT", label: "Current", hint: "In flight now" },
  { key: "PLANNED", label: "Planned", hint: "Committed, not started" },
  { key: "FUTURE", label: "Future", hint: "Candidate / someday" },
];

function RoadmapTab({
  store,
  state,
  productId,
  onOpenProduct,
}: {
  store: Store;
  state: StoreGraph;
  productId: string;
  onOpenProduct: (id: string) => void;
}) {
  const [adding, setAdding] = useState<RoadmapColumn | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [linkedProductId, setLinkedProductId] = useState<string>("");
  const [daupProjectRef, setDaupProjectRef] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  // Place context for the Open-in-Project hints (house mode only; standalone has none).
  const session = useSession();
  const placeId = session.mode === "house" ? session.placeId : null;

  const items = (state.roadmapItems ?? [])
    .filter((r) => r.dataProductId === productId)
    .sort((a, b) => a.order - b.order);
  // Candidate link targets: every active product in the registry except this one.
  const linkTargets = store.activeProducts().filter((p) => p.id !== productId);

  const resetForm = () => {
    setTitle("");
    setNote("");
    setLinkedProductId("");
    setDaupProjectRef("");
    setAdding(null);
    setEditingId(null);
  };

  const submitAdd = async (column: RoadmapColumn) => {
    const res = (await store.dispatch({
      type: "ADD_ROADMAP_ITEM",
      productId,
      column,
      title,
      note,
      linkedProductId: linkedProductId || null,
      daupProjectRef: daupProjectRef.trim() || null,
    })) as any;
    if (res.ok) resetForm();
    else setWarn(res.message || "Could not add the tile.");
  };

  const submitEdit = async (itemId: string) => {
    const res = (await store.dispatch({
      type: "EDIT_ROADMAP_ITEM",
      itemId,
      title,
      note,
      linkedProductId: linkedProductId || null,
      daupProjectRef: daupProjectRef.trim() || null,
    })) as any;
    if (res.ok) resetForm();
    else setWarn(res.message || "Could not save the tile.");
  };

  const beginEdit = (it: RoadmapItem) => {
    setEditingId(it.id);
    setAdding(null);
    setTitle(it.title);
    setNote(it.note);
    setLinkedProductId(it.linkedProductId || "");
    setDaupProjectRef(it.daupProjectRef || "");
    setWarn(null);
  };

  const move = (it: RoadmapItem, column: RoadmapColumn) => {
    void store.dispatch({ type: "MOVE_ROADMAP_ITEM", itemId: it.id, column });
  };
  const remove = (it: RoadmapItem) => {
    if (window.confirm(`Remove the roadmap tile "${it.title}"?`)) {
      void store.dispatch({ type: "REMOVE_ROADMAP_ITEM", itemId: it.id });
    }
  };

  const addForm = (column: RoadmapColumn) => (
    <div className="card card--subtle" style={{ marginBottom: "10px" }}>
      <div className="stack gap-3">
        <div className="field">
          <label className="field__label">Project title</label>
          <input className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label className="field__label">Note (optional)</label>
          <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Link to a registry product (optional)</label>
          <select className="field__select" value={linkedProductId} onChange={(e) => setLinkedProductId(e.target.value)}>
            <option value="">— none —</option>
            {linkTargets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">daup-projects reference (optional)</label>
          <input
            className="field__input"
            placeholder="project.daup.co.za URL or a project/place handle"
            value={daupProjectRef}
            onChange={(e) => setDaupProjectRef(e.target.value)}
          />
          <div className="rigour-gate__sub" style={{ margin: "4px 0 0", fontSize: ".66rem" }}>
            Adds an “Open in Project ↗” button. Opens the Project app (its own sign-in) — duidelik stores no project data.
          </div>
        </div>
        <div className="row gap-3" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn--ghost" onClick={resetForm}>
            Cancel
          </button>
          <button
            className="btn btn--ai"
            disabled={!title.trim()}
            onClick={() => (editingId ? submitEdit(editingId) : submitAdd(column))}
          >
            {editingId ? "Save" : "Add tile"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="card" style={{ borderTopLeftRadius: 0 }}>
      <div className="row row--between" style={{ marginBottom: "14px" }}>
        <div>
          <div className="eyebrow eyebrow--teal">{`Roadmap — ${items.length} project${items.length === 1 ? "" : "s"}`}</div>
          <div className="rigour-gate__sub" style={{ margin: "4px 0 0" }}>
            Projects for this product across Current / Planned / Future. Tiles can link to a registry product.
            <span style={{ color: "var(--fg-3)" }}> daup-projects integration + project plans are a later wave.</span>
          </div>
        </div>
      </div>

      {warn ? (
        <div className="rigour-gate__sub" style={{ marginBottom: "10px", color: "var(--amber)" }}>
          {warn}
        </div>
      ) : null}

      <div className="roadmap-board" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
        {ROADMAP_COLUMNS.map((col) => {
          const colItems = items.filter((r) => r.column === col.key);
          return (
            <div key={col.key} className="card card--subtle roadmap-col" style={{ minHeight: "120px" }}>
              <div className="row row--between" style={{ marginBottom: "8px", alignItems: "baseline" }}>
                <div>
                  <div className="eyebrow eyebrow--muted">{col.label}</div>
                  <div className="rigour-gate__sub" style={{ margin: "2px 0 0", fontSize: ".64rem" }}>
                    {col.hint}
                  </div>
                </div>
                <span className="chip chip--locked" style={{ fontSize: ".62rem" }}>
                  {colItems.length}
                </span>
              </div>

              {colItems.length === 0 && adding !== col.key ? (
                <div className="rigour-gate__sub" style={{ fontSize: ".72rem", padding: "6px 0" }}>
                  No projects.
                </div>
              ) : null}

              <div className="stack gap-3">
                {colItems.map((it) =>
                  editingId === it.id ? (
                    <Fragment key={it.id}>{addForm(col.key)}</Fragment>
                  ) : (
                    <RoadmapTile
                      key={it.id}
                      item={it}
                      linked={it.linkedProductId ? store.product(it.linkedProductId) : null}
                      placeId={placeId}
                      onOpenLinked={onOpenProduct}
                      onEdit={() => beginEdit(it)}
                      onRemove={() => remove(it)}
                      onMove={(c) => move(it, c)}
                    />
                  ),
                )}
              </div>

              {adding === col.key ? (
                <div className="mt-4">{addForm(col.key)}</div>
              ) : (
                <button
                  className="btn btn--ghost"
                  style={{ width: "100%", marginTop: "10px" }}
                  onClick={() => {
                    resetForm();
                    setAdding(col.key);
                  }}
                >
                  + Add project
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoadmapTile({
  item,
  linked,
  placeId,
  onOpenLinked,
  onEdit,
  onRemove,
  onMove,
}: {
  item: RoadmapItem;
  linked: DataProduct | null;
  placeId: string | null;
  onOpenLinked: (id: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (column: RoadmapColumn) => void;
}) {
  const others = ROADMAP_COLUMNS.filter((c) => c.key !== item.column);
  // A-i: build the Open-in-Project deep link from the tile's ref + place context.
  // Null when the tile carries no daupProjectRef (no button rendered).
  const projectUrl = buildOpenInProjectUrl({ daupProjectRef: item.daupProjectRef, placeId });
  const openInProject = () => {
    if (projectUrl && typeof window !== "undefined") window.open(projectUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="card roadmap-tile" style={{ padding: "10px 12px" }}>
      <div className="row row--between" style={{ alignItems: "flex-start", gap: "8px" }}>
        <div style={{ fontWeight: 800, fontSize: ".82rem" }}>{item.title}</div>
        <div className="row gap-2">
          <span
            role="button"
            tabIndex={0}
            title="Edit"
            style={{ cursor: "pointer", color: "var(--label)", fontSize: ".72rem" }}
            onClick={onEdit}
          >
            edit
          </span>
          <span
            role="button"
            tabIndex={0}
            title="Remove"
            style={{ cursor: "pointer", color: "var(--label)", fontSize: ".72rem" }}
            onClick={onRemove}
          >
            ✕
          </span>
        </div>
      </div>
      {item.note ? (
        <div className="rigour-gate__sub" style={{ margin: "6px 0 0", fontSize: ".74rem", color: "var(--fg-2)" }}>
          {item.note}
        </div>
      ) : null}
      {linked ? (
        <div style={{ marginTop: "8px" }}>
          <span
            role="button"
            tabIndex={0}
            className="chip chip--active"
            style={{ cursor: "pointer", fontWeight: 700 }}
            title={`Open ${linked.code}`}
            onClick={() => onOpenLinked(linked.id)}
          >
            🔗 {linked.code}
          </span>
        </div>
      ) : item.linkedProductId ? (
        <div className="rigour-gate__sub" style={{ marginTop: "8px", fontSize: ".68rem", color: "var(--amber)" }}>
          linked product not found
        </div>
      ) : null}
      {projectUrl ? (
        <div style={{ marginTop: "8px" }}>
          <button
            className="btn btn--ghost"
            style={{ fontSize: ".68rem", padding: "4px 10px" }}
            title="Open this project in the daup Project app (its own sign-in)"
            onClick={openInProject}
          >
            Open in Project ↗
          </button>
        </div>
      ) : null}
      <div className="row gap-2" style={{ marginTop: "10px", flexWrap: "wrap" }}>
        {others.map((c) => (
          <button
            key={c.key}
            className="btn btn--ghost"
            style={{ fontSize: ".66rem", padding: "4px 8px" }}
            title={`Move to ${c.label}`}
            onClick={() => onMove(c.key)}
          >
            → {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── print ──
// Opens a clean, self-contained print window for a BRD/FSD/QRG. Renders the document
// from the same section schema the editor uses (so all three doc types print
// uniformly), plus placement, status, rigour tally and signature. Pure read — never
// mutates the store. Escapes all values (no HTML injection from content).
// Ported from app/ui/Product.js; JS→TS typing, matched to the current docSchemas kinds.
function printDocument({
  docType,
  doc,
  product,
  placementPath,
  signature,
  resolveUser,
  checks,
}: {
  docType: DocTypeValue;
  doc: DuidelikDocument;
  product: DataProduct;
  placementPath: string;
  signature: Signature | null;
  resolveUser: (id: string) => any;
  checks: RigourCheck[];
}) {
  const esc = escapeHtml;
  const title = docTypeTitle(docType);
  const content = (doc.content || {}) as Record<string, unknown>;

  const renderObj = (o: Record<string, unknown>): string =>
    Object.entries(o)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => "<b>" + esc(k) + ":</b> " + (Array.isArray(val) || typeof val === "object" ? renderVal(val) : renderRichText(val)))
      .join(" &nbsp; ");
  const renderText = renderRichText;
  const renderVal = (v: unknown): string => {
    if (v == null || v === "") return '<span class="muted">—</span>';
    if (Array.isArray(v)) {
      if (!v.length) return '<span class="muted">—</span>';
      // An array of OBJECTS (success metrics, data sources, requirements…) prints as a
      // readable TABLE — one row per item, one column per field — instead of nested
      // "key: value" bullets (the reported problem). A scalar array stays a bullet list.
      const objectRows = v.filter((it) => it && typeof it === "object" && !Array.isArray(it));
      if (objectRows.length === v.length) {
        return renderObjectArrayTable(v as Array<Record<string, unknown>>);
      }
      return "<ul>" + v.map((it) => "<li>" + (it && typeof it === "object" ? renderObj(it as Record<string, unknown>) : escapeHtml(it)) + "</li>").join("") + "</ul>";
    }
    if (typeof v === "object") return renderObj(v as Record<string, unknown>);
    return renderText(v);
  };

  const sections = sectionsFor(docType)
    .map((sec) => {
      const rows = sec.fields
        .map((f) => {
          let v: unknown;
          if (f.kind === "readonly-oneliner") v = product.oneLiner;
          else if (f.kind === "readonly-breadcrumb") v = placementPath;
          else if (f.kind === "owner-picker") {
            // content.ownerId is a ULID — print the person's NAME, not the raw id.
            const oid = (content[f.key] as string) || product.ownerId || null;
            const u = oid ? resolveUser(oid) : null;
            v = u ? `${u.name} (${roleLabel(u.role)})` : oid || null;
          } else v = content[f.key];
          return `<div class="field"><div class="flabel">${esc(f.label)}</div><div class="fval">${renderVal(v)}</div></div>`;
        })
        .join("");
      return `<section><h2>${esc(sec.label)}</h2>${rows}</section>`;
    })
    .join("");

  const owner = product.ownerId ? resolveUser(product.ownerId) : null;
  const tally =
    checks && checks.length
      ? (() => {
          const g = checks.filter((c) => c.score === "GREEN").length;
          const a = checks.filter((c) => c.score === "AMBER").length;
          const r = checks.filter((c) => c.score === "RED").length;
          return `${g} pass · ${a} amber · ${r} red`;
        })()
      : "not yet scored";
  const sigLine = signature
    ? `Signed by ${esc(resolveUser(signature.signedById)?.name || signature.signedById)} (${esc(signature.signedByRole)}) on ${esc(
        new Date(signature.signedAt).toLocaleString(),
      )} · checklist ${esc(signature.checklistVersion)}`
    : `Status: ${esc(doc.status)} · not signed`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(product.code)} — ${esc(title)}</title>
<style>
  @media print { @page { margin: 18mm; } .noprint { display:none; } }
  body { font-family: Inter, "Segoe UI", Arial, sans-serif; color:#111; max-width: 820px; margin: 24px auto; padding: 0 16px; line-height: 1.5; }
  .strip { height:6px; background: linear-gradient(90deg,#e30613 0 46%,#fff 46% 49%,#008b83 49%); border-radius:3px; margin-bottom:16px; }
  .crumb { font-size:.72rem; letter-spacing:.06em; color:#667; text-transform:uppercase; }
  h1 { font-size:1.5rem; margin:4px 0 2px; }
  .meta { font-size:.8rem; color:#445; margin-bottom:4px; }
  .sig { font-size:.8rem; color:#036; background:#f0f7f6; border:1px solid #cde; border-radius:6px; padding:8px 10px; margin:10px 0 18px; }
  h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.06em; color:#008b83; border-bottom:1px solid #e3e7ea; padding-bottom:3px; margin:18px 0 8px; }
  .field { margin:6px 0; }
  .flabel { font-size:.68rem; text-transform:uppercase; letter-spacing:.05em; color:#889; }
  .fval { font-size:.9rem; }
  .muted { color:#aab; } ul { margin:4px 0 4px 18px; padding:0; } li { margin:2px 0; }
  .fval p { margin:4px 0; }
  ol.decision-list { margin:4px 0 4px 20px; padding:0; }
  ol.decision-list li { margin:4px 0; padding-left:4px; line-height:1.45; }
  table.grid { width:100%; border-collapse:collapse; margin:4px 0 8px; font-size:.82rem; }
  table.grid th { text-align:left; font-size:.64rem; text-transform:uppercase; letter-spacing:.04em; color:#667; border-bottom:1.5px solid #cdd3d8; padding:4px 8px 4px 0; white-space:nowrap; }
  table.grid td { vertical-align:top; padding:5px 8px 5px 0; border-bottom:1px solid #eef1f3; color:#223; }
  table.grid tr:last-child td { border-bottom:0; }
  table.grid td b { color:#445; font-weight:600; }
  .btn { font:inherit; padding:8px 16px; border:1px solid #008b83; background:#008b83; color:#fff; border-radius:6px; cursor:pointer; }
  .foot { margin-top:24px; font-size:.68rem; color:#99a; border-top:1px solid #eee; padding-top:8px; }
</style></head><body>
  <div class="strip"></div>
  <div class="crumb">${esc(placementPath)}</div>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(product.code)} — ${esc(product.name)} · Owner: ${esc(owner ? owner.name : "—")}</div>
  <div class="sig">${sigLine} · Rigour: ${tally}</div>
  ${sections}
  <div class="foot">Printed from duidelik · ${esc(new Date().toLocaleString())}</div>
  <p class="noprint" style="margin-top:20px"><button class="btn" onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) {
    alert("Pop-up blocked — allow pop-ups to print.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Render an array of like-shaped objects as a readable table — one row per item, one
// column per field, headers title-cased ("metric" → "Metric"). Columns are the union
// of keys in first-seen order. A cell that is itself an array/object is rendered
// compactly (joined scalars / "k: v" pairs) so the table stays flat. Empty cells show
// a dash. Presentation only; always escapes. This is what turns the nested
// "metric: … target: … baseline: …" bullet blobs into a scannable grid.
export function renderObjectArrayTable(rows: Array<Record<string, unknown>>): string {
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row || {})) if (!cols.includes(k)) cols.push(k);
  }
  if (!cols.length) return '<span class="muted">—</span>';
  const head = "<tr>" + cols.map((c) => "<th>" + escapeHtml(titleCase(c)) + "</th>").join("") + "</tr>";
  const body = rows
    .map((row) => {
      const cells = cols
        .map((c) => "<td>" + renderCell((row || {})[c]) + "</td>")
        .join("");
      return "<tr>" + cells + "</tr>";
    })
    .join("");
  return '<table class="grid"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
}

// A single table cell: scalars escaped; a scalar array joined with "; "; an object as
// compact "key: value" pairs. Keeps a row on one line rather than nesting a sub-list.
function renderCell(v: unknown): string {
  if (v == null || v === "") return '<span class="muted">—</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="muted">—</span>';
    return v
      .map((it) => (it && typeof it === "object" ? compactObject(it as Record<string, unknown>) : escapeHtml(it)))
      .join("; ");
  }
  if (typeof v === "object") return compactObject(v as Record<string, unknown>);
  return escapeHtml(v);
}

function compactObject(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, val]) => val != null && val !== "")
    .map(([k, val]) => "<b>" + escapeHtml(titleCase(k)) + ":</b> " + (typeof val === "object" ? escapeHtml(JSON.stringify(val)) : escapeHtml(val)))
    .join(", ");
}

// "metric" → "Metric"; "brdRef" → "Brd Ref"; "owner" → "Owner". Best-effort label-ising
// of a content field key for a table header.
export function titleCase(key: string): string {
  const spaced = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Human label for a Role enum value (print only; panels.tsx has its own copy).
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

// ── helpers ──

// HTML-escape any value for safe insertion into the print window (no injection from
// author content). Exported for reuse + testability.
export function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

// Readable HTML for a free-text field in the printed doc. A long "Business decision"
// is commonly written as an enumerated run-on ("1. … 2. … 3. …") or with hard line
// breaks; printed as one escaped blob it collapses into an unreadable wall (the
// reported BRD problem). So: an inline numbered run-on (≥2 "N."/"N)" markers) renders
// as an ordered list; otherwise blank lines become paragraphs and single newlines
// become <br>. Presentation only — stored content is never changed. Always escapes.
export function renderRichText(v: unknown): string {
  const raw = String(v == null ? "" : v);
  if (!raw.trim()) return '<span class="muted">—</span>';
  // Split before each "N." / "N)" enumerator that follows whitespace (so inner periods
  // like "GEB vs." or "(CFO)" do not split). Require ≥2 numbered items.
  const parts = raw
    .split(/\s+(?=\d{1,2}[.)]\s)/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const numbered = parts.filter((p) => /^\d{1,2}[.)]\s/.test(p));
  if (parts.length >= 2 && numbered.length >= 2) {
    const items = parts.map((p) => "<li>" + escapeHtml(p.replace(/^\d{1,2}[.)]\s*/, "")) + "</li>").join("");
    return '<ol class="decision-list">' + items + "</ol>";
  }
  const paras = raw
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean);
  return paras.map((para) => "<p>" + escapeHtml(para).replace(/\n/g, "<br>") + "</p>").join("");
}

function tabLabel(t: string) {
  if (t === "GLOSSARY") return "Glossary";
  if (t === "ROADMAP") return "Roadmap";
  return t;
}
function docTypeTitle(t: string) {
  return (
    (
      {
        BRD: "Business Requirement Document",
        FSD: "Functional Specification Document",
        QRG: "Quick Reference Guide",
      } as Record<string, string>
    )[t] || t
  );
}
function pathFor(state: StoreGraph, product: DataProduct) {
  const sd = state.subDomains.find((s) => s.id === product.subDomainId);
  const dom = sd && state.domains.find((d) => d.id === sd.domainId);
  const str = dom && state.streams.find((s) => s.id === dom.streamId);
  return ["duidelik", str && str.name, dom && dom.name, sd && sd.name].filter(Boolean).join(" › ");
}
function latestSignature(state: StoreGraph, documentId: string): Signature | null {
  const sigs = state.signatures.filter((s) => s.documentId === documentId);
  return sigs.length ? sigs[sigs.length - 1] : null;
}
