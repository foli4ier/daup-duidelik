// duidelik — App shell: top bar (acting-as + registry tools) and route between the
// Registry home and a Product's lifecycle view.
// Ported from app/ui/App.js (hyperscript → JSX). State-based routing kept from v1;
// identity still flows through the store's actingUser() selector (SessionContext is
// the forward seam for the P3 house session, DAUP-PORT-PLAN §5).

import { useEffect, useRef, useState } from "react";
import { useStoreState } from "./context/StoreContext";
import { Registry } from "./pages/Registry";
import { ProductScreen } from "./pages/Product";
import type { Store } from "./core/store";
import type { StoreGraph } from "./types";
import type { AiClient } from "./core/aiClient";

type Route = { view: "registry" } | { view: "product"; productId: string };

export function App({ store, aiClient }: { store: Store; aiClient: AiClient | null }) {
  const state = useStoreState(store);
  const [route, setRoute] = useState<Route>({ view: "registry" });

  // let the dev tour hook (main.tsx) drive navigation; no-op in normal use
  useEffect(() => {
    if (typeof window !== "undefined" && typeof (window as any).__duidelikSetOpener === "function") {
      (window as any).__duidelikSetOpener((id: string) => setRoute({ view: "product", productId: id }));
    }
  }, []);

  return (
    <div className="du-root" style={{ maxWidth: "1100px", margin: "0 auto" }}>
      <TopBar store={store} state={state} />
      {route.view === "registry" ? (
        <Registry store={store} state={state} onOpenProduct={(id) => setRoute({ view: "product", productId: id })} />
      ) : (
        <ProductScreen
          store={store}
          state={state}
          productId={route.productId}
          aiClient={aiClient}
          onBack={() => setRoute({ view: "registry" })}
          onOpenProduct={(id) => setRoute({ view: "product", productId: id })}
        />
      )}
    </div>
  );
}

function TopBar({ store, state }: { store: Store; state: StoreGraph }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const acting = store.actingUser();

  const roleBadge = (role: string) => <span className="acting-as__role">{roleLabel(role)}</span>;

  const exportRegistry = () => {
    const blob = new Blob([store.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "duidelik-registry.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  const importRegistry = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        store.importJson(String(reader.result));
      } catch (err) {
        alert("Import failed: " + (err as Error).message);
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  return (
    <div className="row row--between" style={{ padding: "16px 26px 0" }}>
      <div
        className="row gap-3"
        style={{ color: "#d5dade", fontSize: ".72rem", letterSpacing: ".12em", fontWeight: 800, textTransform: "uppercase" }}
      >
        <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: "var(--t)", boxShadow: "var(--glow-dot)" }} />
        duidelik
      </div>
      <div className="row gap-3">
        <button className="btn btn--ghost" onClick={exportRegistry}>
          Export
        </button>
        <button className="btn btn--ghost" onClick={() => fileRef.current && fileRef.current.click()}>
          Import
        </button>
        <input type="file" accept="application/json" ref={fileRef} style={{ display: "none" }} onChange={importRegistry} />
        <button
          className="btn btn--ghost"
          onClick={() => {
            if (confirm("Reset to the seeded registry? This discards local changes.")) store.reset();
          }}
        >
          Reset
        </button>
        <div className="acting-as">
          <div
            className="acting-as__current"
            onClick={() => setMenuOpen(!menuOpen)}
            role="button"
            tabIndex={0}
          >
            {store.isHouseMode() ? "Signed in: " : "Acting as: "}
            {acting ? acting.name : "—"}
            {acting ? roleBadge(acting.role) : <span className="acting-as__role">viewer</span>}
            <span style={{ color: "var(--label)" }}> ▾</span>
          </div>
          {menuOpen ? (
            store.isHouseMode() ? (
              <HouseRoster store={store} onClose={() => setMenuOpen(false)} />
            ) : (
              <div className="acting-as__menu">
                {state.users.map((u) => (
                  <div
                    key={u.id}
                    className={"acting-as__item" + (acting && acting.id === u.id ? " acting-as__item--current" : "")}
                    onClick={() => {
                      store.dispatch({ type: "SET_ACTING_USER", userId: u.id });
                      setMenuOpen(false);
                    }}
                  >
                    <span>{u.name}</span>
                    {roleBadge(u.role)}
                  </div>
                ))}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
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

const ROLE_OPTIONS = ["PRODUCT_OWNER", "PRODUCT_MANAGER", "BUSINESS_ANALYST", "FUNCTIONAL_ANALYST"];

// Per-place roster manager (house mode). Shows every member + role; a PO can reassign
// roles. Reads the roster from the store (DAUP-PORT-PLAN §5 / O1). Not a user picker —
// identity is the session; this only edits each person's duidelik role.
function HouseRoster({ store, onClose }: { store: Store; onClose: () => void }) {
  const me = store.actingMember();
  const isPo = me?.role === "PRODUCT_OWNER";
  const roster = store.members();

  // PO-only inline controls: rename an existing member, and onboard a new one by name.
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [onboardName, setOnboardName] = useState("");
  const [onboardRole, setOnboardRole] = useState("PRODUCT_OWNER");
  const [err, setErr] = useState<string | null>(null);

  const startRename = (key: string, current: string) => {
    setErr(null);
    setRenameKey(key);
    setRenameVal(current);
  };
  const commitRename = async (key: string) => {
    const name = renameVal.trim();
    if (!name) {
      setErr("Name cannot be empty.");
      return;
    }
    const r = await store.dispatch({ type: "RENAME_MEMBER", targetKey: key, name });
    if (!r.ok) {
      setErr(r.message || "Rename failed.");
      return;
    }
    setRenameKey(null);
    setRenameVal("");
  };
  const commitOnboard = async () => {
    const name = onboardName.trim();
    if (!name) {
      setErr("Enter a name to onboard.");
      return;
    }
    const r = await store.dispatch({ type: "ONBOARD_MEMBER", name, role: onboardRole as any });
    if (!r.ok) {
      setErr(r.message || "Onboarding failed.");
      return;
    }
    setOnboardName("");
    setErr(null);
  };

  return (
    <div className="acting-as__menu" style={{ minWidth: 320 }}>
      <div className="acting-as__item" style={{ cursor: "default", opacity: 0.8 }}>
        <span>Place roster — {roster.length} member{roster.length === 1 ? "" : "s"}</span>
      </div>
      {roster.map((m) => {
        const isMe = me && m.key === me.key;
        const editing = renameKey === m.key;
        return (
          <div key={m.key} className={"acting-as__item" + (isMe ? " acting-as__item--current" : "")} style={{ cursor: "default", flexWrap: "wrap", gap: 6 }}>
            {editing ? (
              <>
                <input
                  className="field__input"
                  style={{ padding: "2px 6px", fontSize: ".72rem", flex: "1 1 120px" }}
                  value={renameVal}
                  autoFocus
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(m.key);
                    if (e.key === "Escape") setRenameKey(null);
                  }}
                />
                <span className="acting-as__role" style={{ cursor: "pointer" }} onClick={() => void commitRename(m.key)}>Save</span>
                <span className="acting-as__role" style={{ cursor: "pointer", opacity: 0.7 }} onClick={() => setRenameKey(null)}>Cancel</span>
              </>
            ) : (
              <>
                <span>
                  {m.name}
                  {m.bootstrap ? " ·★" : ""}
                  {m.pending ? " ·(pending)" : ""}
                  {isMe ? " (you)" : ""}
                </span>
                {isPo ? (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <select
                      className="field__select"
                      style={{ padding: "2px 6px", fontSize: ".7rem" }}
                      value={m.role}
                      onChange={(e) => store.dispatch({ type: "ASSIGN_ROLE", targetKey: m.key, role: e.target.value as any })}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                    <span className="acting-as__role" style={{ cursor: "pointer" }} onClick={() => startRename(m.key, m.name)}>Rename</span>
                  </span>
                ) : (
                  <span className="acting-as__role">{roleLabel(m.role)}</span>
                )}
              </>
            )}
          </div>
        );
      })}
      {isPo ? (
        <div className="acting-as__item" style={{ cursor: "default", flexWrap: "wrap", gap: 6, borderTop: "1px solid var(--border-soft)" }}>
          <input
            className="field__input"
            style={{ padding: "2px 6px", fontSize: ".72rem", flex: "1 1 120px" }}
            placeholder="Onboard a person by name"
            value={onboardName}
            onChange={(e) => setOnboardName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void commitOnboard(); }}
          />
          <select
            className="field__select"
            style={{ padding: "2px 6px", fontSize: ".7rem" }}
            value={onboardRole}
            onChange={(e) => setOnboardRole(e.target.value)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <span className="acting-as__role" style={{ cursor: "pointer" }} onClick={() => void commitOnboard()}>Add</span>
        </div>
      ) : (
        <div className="acting-as__item" style={{ cursor: "default", opacity: 0.7, fontSize: ".72rem" }}>
          <span>Only a Product Owner can change roles or onboard members.</span>
        </div>
      )}
      {err ? (
        <div className="acting-as__item" style={{ cursor: "default", color: "var(--red)", fontSize: ".72rem" }}>
          <span>{err}</span>
        </div>
      ) : null}
      <div className="acting-as__item" onClick={onClose} style={{ justifyContent: "flex-end" }}>
        <span className="acting-as__role">Close</span>
      </div>
    </div>
  );
}
