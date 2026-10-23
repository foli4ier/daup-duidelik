// daup-duidelik — Root: the house-session gate + router shell (DAUP-PORT-PLAN §4-§5).
//
// Owns the session. Three states:
//   • /d/hub?houseRedeem=… → HubRedeem redeems, lifts the session here, routes to "/".
//   • a session is held → build the placeId-scoped store (shared per place, O2) in
//     HOUSE mode (acting role from the per-place roster) and render the app shell.
//   • no session, direct hit → STANDALONE fallback (seeded "acting as" picker), UNLESS
//     VITE_REQUIRE_HOUSE_SESSION is true, in which case show "open from the Hub".
//
// The session is held in memory + sessionStorage (per-tab) so a reload inside the tab
// keeps it until the short-lived bearer expires. duidelik never mints a session.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { createStore } from "./core/store";
import { createAiClient } from "./core/aiClient";
import type { AiTransport } from "./core/aiClient";
import { fetchRemoteGraph, pushRemoteGraph } from "./api/remoteStore";
import { App } from "./App";
import { HubRedeem } from "./hub/HubRedeem";
import { SessionProvider, STANDALONE_SESSION } from "./context/SessionContext";
import type { SessionInfo, HouseSession } from "./context/SessionContext";

const SESSION_KEY = "duidelik.session.v1";
const REQUIRE_HOUSE = String(import.meta.env.VITE_REQUIRE_HOUSE_SESSION) === "true";

function loadHeldSession(): HouseSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as HouseSession;
    if (s && s.mode === "house" && typeof s.placeId === "string" && typeof s.bearer === "string") {
      // Drop an expired session (fail closed).
      if (s.expiresAt && Date.now() >= s.expiresAt) return null;
      return s;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function aiTransport(): AiTransport | null {
  return typeof window !== "undefined" && typeof window.duidelikModelCall === "function"
    ? window.duidelikModelCall
    : null;
}

export function Root() {
  const [house, setHouse] = useState<HouseSession | null>(() => loadHeldSession());

  const onSession = useCallback((s: HouseSession) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* non-fatal */
    }
    setHouse(s);
  }, []);

  // The effective session: a held house session, else standalone.
  const session: SessionInfo = house ?? STANDALONE_SESSION;

  // Build the store keyed to the session. placeId-scoped in house mode (shared per
  // place, O2); unscoped standalone key otherwise. Rebuilt only when identity changes.
  const aiClient = useMemo(() => {
    const t = aiTransport();
    return createAiClient(t ? { transport: t } : {});
  }, []);

  const store = useMemo(() => {
    if (house) {
      return createStore({
        aiClient,
        placeId: house.placeId,
        session: { peerId: house.peerId, phone: house.phone },
      });
    }
    return createStore({ aiClient });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [house?.placeId, house?.peerId, house?.phone, aiClient]);

  // ── Durable persistence (STACK §5): in HOUSE mode the seed node is the source of
  //    truth. On mount, pull the place's stored registry and adopt it if present
  //    (server wins over the local cache). Then write-through every committed change
  //    to the seed (debounced). localStorage stays the local cache / offline buffer.
  //    Fails SOFT: a seed hiccup degrades to local-only, never breaks the app.
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!house) return;
    const { placeId, bearer, seedOrigin } = house;
    let cancelled = false;
    let pushTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const r = await fetchRemoteGraph({ seedOrigin, placeId, bearer });
      if (cancelled) return;
      if (r.ok && r.graph) {
        try {
          store.importJson(r.graph); // server wins; store migrates on import
        } catch {
          /* stored graph unreadable — keep local, the next push repairs it */
        }
      }
      // Mark hydrated so the write-through below does not immediately echo the pull.
      hydratedRef.current = placeId;
    })();

    const unsub = store.subscribe(() => {
      if (hydratedRef.current !== placeId) return; // ignore pre-hydrate churn
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        void pushRemoteGraph({ seedOrigin, placeId, bearer, graph: store.getState() });
      }, 400);
    });

    return () => {
      cancelled = true;
      if (pushTimer) clearTimeout(pushTimer);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [house?.placeId, house?.bearer, house?.seedOrigin, store]);

  // Expose the store for the headless tour hook (parity with the v1 build). The opener
  // itself is registered by App via window.__duidelikSetOpener; we only re-point the
  // store handle here so the tour can read/dispatch against the live store.
  if (typeof window !== "undefined") {
    const prev = window.__duidelik?.open;
    window.__duidelik = { store, open: prev ?? (() => {}) };
  }

  return (
    <SessionProvider session={session}>
      <Routes>
        <Route path="/d/hub" element={<HubRedeem onSession={onSession} />} />
        <Route
          path="*"
          element={
            !house && REQUIRE_HOUSE ? (
              <RequireHubNotice />
            ) : (
              <App store={store} aiClient={aiClient} />
            )
          }
        />
      </Routes>
    </SessionProvider>
  );
}

function RequireHubNotice() {
  return (
    <div className="screen du-root">
      <div className="brand-strip" />
      <div className="screen__body">
        <h1 className="wordmark">
          duidelik<span className="dot">.</span>
        </h1>
        <div className="card card--dashed" style={{ maxWidth: 520, marginTop: "16px" }}>
          <div className="eyebrow eyebrow--muted" style={{ marginBottom: "8px" }}>
            Session required
          </div>
          <div className="rigour-gate__sub">
            This duidelik is in house-session mode. Open it from the daup Hub to sign in — it does
            not run its own sign-in.
          </div>
        </div>
      </div>
    </div>
  );
}
