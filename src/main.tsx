// daup-duidelik — app entry. Mounts the Root session-gate inside a BrowserRouter and
// imports the Shoprite theme (tokens + components) bundled in src/theme
// (DAUP-PORT-PLAN §0: keep duidelik's own theme, no daup-theme dependency).
//
// The store + aiClient are built inside Root once the house session is known
// (placeId-scoped, DAUP-PORT-PLAN §4-§5), so there is no store construction here.
//
// aiClient transport: the runtime's model-call surface is injected via
// window.duidelikModelCall if present (on daup this becomes the Worker /ai/* route,
// P5). Absent → NULL client → co-author offline + deterministic rigour (STACK §4). No
// secret in client code: we never embed an API key.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./theme/tokens.css";
import "./theme/components.css";
import { Root } from "./Root";
import { workerAiTransport } from "./api/aiTransport";
import type { createStore } from "./core/store";
import type { AiTransport } from "./core/aiClient";

declare global {
  interface Window {
    duidelikModelCall?: AiTransport;
    __duidelik?: { store: ReturnType<typeof createStore>; open: (pid: string) => void };
    __duidelikSetOpener?: (fn: (pid: string) => void) => void;
  }
}

// Inject the AI transport (P5): the Worker /ai/* route. Root reads
// window.duidelikModelCall; if the Worker returns 503 (no AI_API_KEY secret set) the
// call rejects and the co-author simply shows its offline state — the app still runs.
// A host that already provides its own duidelikModelCall wins (we don't clobber it).
if (typeof window !== "undefined" && typeof window.duidelikModelCall !== "function") {
  window.duidelikModelCall = workerAiTransport;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </StrictMode>,
);
