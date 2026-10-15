// duidelik — Registry home (§7 registry-home + §9 register modal)
//
// Left: domain tree (Stream → Domain → SubDomain → leaf counts). Right: product cards
// for the selected sub-domain, each with the compact pipeline + rigour preview when
// blocked. "+ Register" opens the modal (the one place --shadow is used).
// Ported from app/ui/Registry.js (hyperscript → JSX).

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LifecycleStage, DocStatus, DocType, Score } from "../core/enums";
import { Pipeline } from "../components/LifecycleRail";
import type { Store } from "../core/store";
import type { StoreGraph, DataProduct, SubDomain, Stream, Domain } from "../types";

export function Registry({
  store,
  state,
  onOpenProduct,
}: {
  store: Store;
  state: StoreGraph;
  onOpenProduct: (id: string) => void;
}) {
  const [selectedSub, setSelectedSub] = useState<string | null>(firstSubWithProducts(state));
  const [registerOpen, setRegisterOpen] = useState(false);
  const [openStreams, setOpenStreams] = useState<Set<string>>(() => new Set(state.streams.map((s) => s.id)));
  const [openDomains, setOpenDomains] = useState<Set<string>>(() => new Set(domainsWithProducts(state)));

  const productsInSub = (subId: string) => state.dataProducts.filter((p) => p.subDomainId === subId);
  const selSub = state.subDomains.find((s) => s.id === selectedSub) || null;

  return (
    <div className="screen du-root">
      <div className="brand-strip" />
      <div className="screen__body">
        <div
          className="row gap-3"
          style={{ color: "#d5dade", fontSize: ".72rem", letterSpacing: ".15em", fontWeight: 800, textTransform: "uppercase" }}
        >
          <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "var(--t)", boxShadow: "var(--glow-dot)" }} />
          Shoprite Analytics · Data Product Registry
        </div>
        <h1 className="wordmark">
          duidelik<span className="dot">.</span>
        </h1>
        <p className="lead">
          Every data product, <span className="hl">made clear</span> — browse the domains, open a product, follow its
          lifecycle.
        </p>

        <div className="registry-grid" style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: "20px", marginTop: "22px" }}>
          <div className="card card--list">
            <div className="eyebrow eyebrow--teal" style={{ marginBottom: "12px" }}>
              Domain tree
            </div>
            <div className="domain-tree">
              {renderTree({ state, openStreams, setOpenStreams, openDomains, setOpenDomains, selectedSub, setSelectedSub, productsInSub })}
            </div>
            <button className="btn btn--primary btn--block" style={{ marginTop: "14px" }} onClick={() => setRegisterOpen(true)}>
              + Register domain / product
            </button>
          </div>

          <div>
            <div className="row row--between" style={{ marginBottom: "10px" }}>
              <div className="eyebrow eyebrow--teal">
                {selSub ? `${pathLabel(state, selSub)} — ${productsInSub(selSub.id).length} data products` : "Select a sub-domain"}
              </div>
            </div>
            {selSub ? (
              productsInSub(selSub.id).map((p) => (
                <ProductCard key={p.id} store={store} product={p} onOpen={() => onOpenProduct(p.id)} />
              ))
            ) : (
              <div className="rigour-gate__sub">Pick a leaf in the tree to see its products.</div>
            )}
            {selSub && productsInSub(selSub.id).length === 0 ? (
              <div className="rigour-gate__sub">No products here yet — register one.</div>
            ) : null}
          </div>
        </div>

        {registerOpen ? (
          <RegisterModal
            store={store}
            state={state}
            onClose={() => setRegisterOpen(false)}
            onCreated={(p) => {
              setSelectedSub(p.subDomainId);
              setRegisterOpen(false);
              onOpenProduct(p.id);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProductCard({ store, product, onOpen }: { store: Store; product: DataProduct; onOpen: () => void }) {
  const owner = product.ownerId ? store.resolveUser(product.ownerId) : null;
  const brd = store.docOf(product.id, DocType.BRD);
  const blocked = brd && brd.status === DocStatus.IN_RIGOUR && store.checksForDoc(brd.id).some((c) => c.score === Score.RED);
  const accent = blocked ? "var(--r)" : "var(--t)";
  const chip = chipFor(store, product);

  return (
    <div
      className="card card--list card--accent-left product-card"
      style={{ ["--accent" as any]: accent, cursor: "pointer" }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <div className="row row--between" style={{ alignItems: "start" }}>
        <div>
          <div className="product-card__meta">{`${product.code} · Owner: ${owner ? owner.name : "—"}`}</div>
          <div className="product-card__title">{product.name}</div>
        </div>
        <span className={"chip chip--" + chip.cls}>{chip.label}</span>
      </div>
      <Pipeline product={product} docFor={(t) => store.docOf(product.id, t)} />
    </div>
  );
}

function chipFor(store: Store, product: DataProduct): { cls: string; label: string } {
  const brd = store.docOf(product.id, DocType.BRD);
  const fsd = store.docOf(product.id, DocType.FSD);
  if (product.stage === LifecycleStage.LIVE) return { cls: "signed", label: "✓ LIVE" };
  if (brd && brd.status === DocStatus.IN_RIGOUR) return { cls: "blocked", label: "⚑ BRD AWAITING SIGN" };
  if (fsd && fsd.status !== DocStatus.SIGNED && product.stage === LifecycleStage.FSD)
    return { cls: "active", label: "● FSD IN PROGRESS" };
  if (brd && brd.status === DocStatus.SIGNED) return { cls: "active", label: "● " + product.stage + " IN PROGRESS" };
  return { cls: "active", label: "● " + product.stage };
}

// ── tree rendering ──
function renderTree({
  state,
  openStreams,
  setOpenStreams,
  openDomains,
  setOpenDomains,
  selectedSub,
  setSelectedSub,
  productsInSub,
}: {
  state: StoreGraph;
  openStreams: Set<string>;
  setOpenStreams: (s: Set<string>) => void;
  openDomains: Set<string>;
  setOpenDomains: (s: Set<string>) => void;
  selectedSub: string | null;
  setSelectedSub: (id: string) => void;
  productsInSub: (subId: string) => DataProduct[];
}): ReactNode[] {
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setter(n);
  };
  const rows: ReactNode[] = [];
  for (const stream of [...state.streams].sort(byOrder)) {
    const sOpen = openStreams.has(stream.id);
    rows.push(
      <div
        className="tree-node tree-node--stream"
        key={stream.id}
        onClick={() => toggle(openStreams, setOpenStreams, stream.id)}
        style={{ cursor: "pointer" }}
      >
        <span className="tree-caret">{sOpen ? "▾" : "▸"}</span>
        {stream.name}
      </div>,
    );
    if (!sOpen) continue;
    for (const dom of state.domains.filter((d) => d.streamId === stream.id).sort(byOrder)) {
      const subs = state.subDomains.filter((s) => s.domainId === dom.id);
      const dOpen = openDomains.has(dom.id);
      rows.push(
        <div
          className="tree-node tree-node--group"
          key={dom.id}
          onClick={() => toggle(openDomains, setOpenDomains, dom.id)}
          style={{ cursor: "pointer" }}
        >
          <span className="tree-caret">{subs.length ? (dOpen ? "▾" : "▸") : "·"}</span>
          {dom.name}
        </div>,
      );
      if (!dOpen) continue;
      for (const sub of subs.sort(byOrder)) {
        const count = productsInSub(sub.id).length;
        rows.push(
          <div
            key={sub.id}
            className={"tree-node tree-node--leaf" + (selectedSub === sub.id ? " tree-node--selected" : "")}
            onClick={() => setSelectedSub(sub.id)}
          >
            {sub.name} · <span className="count">{`${count} product${count === 1 ? "" : "s"}`}</span>
          </div>,
        );
      }
    }
  }
  return rows;
}

// ── register modal (§9 screen-register) ──
function RegisterModal({
  store,
  state,
  onClose,
  onCreated,
}: {
  store: Store;
  state: StoreGraph;
  onClose: () => void;
  onCreated: (p: DataProduct) => void;
}) {
  const streams = [...state.streams].sort(byOrder);
  const [streamId, setStreamId] = useState(streams[0]?.id);
  const domains = state.domains.filter((d) => d.streamId === streamId).sort(byOrder);
  const [domainId, setDomainId] = useState(domains[0]?.id);
  const subs = state.subDomains.filter((s) => s.domainId === domainId);
  const [subId, setSubId] = useState(subs[0]?.id || "__new");
  const [newSub, setNewSub] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [oneLiner, setOneLiner] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // keep dependent selects consistent
  useEffect(() => {
    const d = state.domains.filter((x) => x.streamId === streamId).sort(byOrder);
    setDomainId(d[0]?.id);
  }, [streamId]);
  useEffect(() => {
    const s = state.subDomains.filter((x) => x.domainId === domainId);
    setSubId(s[0]?.id || "__new");
  }, [domainId]);

  const create = async () => {
    setErr(null);
    if (!oneLiner.trim()) return setErr("A one-liner is required — it starts the lifecycle.");
    if (!code.trim() || !name.trim()) return setErr("Code and name are required.");
    let targetSub = subId;
    if (subId === "__new") {
      if (!newSub.trim()) return setErr("Name the new sub-domain.");
      const r = (await store.dispatch({ type: "CREATE_SUBDOMAIN", domainId, name: newSub.trim() })) as any;
      targetSub = r.subDomain.id;
    }
    const res = (await store.dispatch({
      type: "REGISTER_PRODUCT",
      code: code.trim(),
      name: name.trim(),
      oneLiner: oneLiner.trim(),
      subDomainId: targetSub,
      ownerId: null,
    })) as any;
    if (res.ok) onCreated(res.product);
    else setErr(res.message || "Could not create product.");
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === "overlay") onClose();
      }}
    >
      <div className="modal">
        <div className="modal__head">
          <div className="modal__title">Register a data product</div>
          <span style={{ color: "var(--label)", cursor: "pointer", fontSize: "1.1rem" }} onClick={onClose}>
            ✕
          </span>
        </div>
        <div className="modal__body">
          <div className="row gap-4">
            {field(
              "Stream (seeded)",
              <select className="field__select" value={streamId} onChange={(e) => setStreamId(e.target.value)}>
                {streams.map((s: Stream) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>,
            )}
            {field(
              "Domain (seeded)",
              <select className="field__select" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {domains.map((d: Domain) => (
                  <option value={d.id} key={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>,
            )}
          </div>
          {field(
            "Sub-domain (choose or create)",
            <select className="field__select" value={subId} onChange={(e) => setSubId(e.target.value)}>
              {subs.map((s: SubDomain) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="__new">+ Create new sub-domain…</option>
            </select>,
          )}
          {subId === "__new"
            ? field(
                "New sub-domain name",
                <input className="field__input" value={newSub} onChange={(e) => setNewSub(e.target.value)} />,
              )
            : null}
          <div className="row gap-4">
            {field(
              "Product code",
              <input className="field__input" placeholder="DAPP-6042" value={code} onChange={(e) => setCode(e.target.value)} />,
              "0 0 160px",
            )}
            {field(
              "Product name",
              <input className="field__input" placeholder="Shepherd — …" value={name} onChange={(e) => setName(e.target.value)} />,
            )}
          </div>
          {field(
            "One-liner · required",
            <textarea
              className="field__textarea"
              placeholder="One sentence: what is this product and who needs it?"
              value={oneLiner}
              onChange={(e) => setOneLiner(e.target.value)}
            />,
          )}
          {err ? (
            <div className="rigour-gate__sub" style={{ color: "var(--red)" }}>
              {err}
            </div>
          ) : null}
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={create}>
            Create product
          </button>
        </div>
      </div>
    </div>
  );
}

function field(label: string, control: ReactNode, flex?: string) {
  return (
    <div className="field" style={flex ? { flex } : { flex: 1 }}>
      <label className="field__label">{label}</label>
      {control}
    </div>
  );
}

// ── helpers ──
function byOrder(a: { order?: number }, b: { order?: number }) {
  return (a.order || 0) - (b.order || 0);
}
function pathLabel(state: StoreGraph, sub: SubDomain) {
  const dom = state.domains.find((d) => d.id === sub.domainId);
  return `${dom ? dom.name : ""} › ${sub.name}`;
}
function firstSubWithProducts(state: StoreGraph): string | null {
  const withP = state.subDomains.find((s) => state.dataProducts.some((p) => p.subDomainId === s.id));
  return (withP || state.subDomains[0])?.id || null;
}
function domainsWithProducts(state: StoreGraph): string[] {
  const ids = new Set<string>();
  for (const p of state.dataProducts) {
    const sd = state.subDomains.find((s) => s.id === p.subDomainId);
    if (sd) ids.add(sd.domainId);
  }
  return [...ids];
}
