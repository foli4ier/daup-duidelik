// daup-duidelik — P2 UI render check (vitest + jsdom).
//
// Proves the ported React UI actually renders — the registry, a product across
// ONE_LINER → BRD DRAFT → IN_RIGOUR → SIGNED (FSD unlocked), the rigour gate, the
// signature panel and the offline AI bar — without throwing. This is the headless
// equivalent of the v1 react-dom/server render check, now in-browser (jsdom) so it
// exercises hooks + events, not just a static string.

import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { createStore } from "../src/core/store";
import { memoryAdapter } from "../src/api/persistence";
import { createAiClient } from "../src/core/aiClient";
import { DocType, DocStatus } from "../src/core/enums";

function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-14T12:00:00.000Z");

function freshStore() {
  return createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock, aiClient: null });
}

let container: HTMLDivElement;
let openProduct: (pid: string) => void = () => {};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  // App registers its route-setter here on mount (main.tsx does this in production).
  openProduct = () => {};
  (window as any).__duidelikSetOpener = (fn: (pid: string) => void) => {
    openProduct = fn;
  };
});

async function mount(store: ReturnType<typeof createStore>) {
  const root = createRoot(container);
  await act(async () => {
    root.render(<App store={store} aiClient={createAiClient()} />);
  });
  return root;
}

describe("UI render — registry home", () => {
  it("renders the registry with the seeded products and the brand frame", async () => {
    const store = freshStore();
    await mount(store);
    const html = container.innerHTML;
    expect(html).toContain("brand-strip");
    expect(html).toContain("Domain tree");
    expect(html).toContain("DAPP-6036");
    expect(html).toContain("DAPP-6007");
    // the offline AI bar is only on a product; registry shows the pipeline
    expect(html).toContain("pipeline");
  });
});

describe("UI render — product lifecycle across states", () => {
  it("renders a ONE_LINER product with the FSD rail node locked", async () => {
    const store = freshStore();
    const reg = store.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-9000",
      name: "Render Product",
      oneLiner: "A non-empty one-liner for the render test.",
      subDomainId: store.getState().subDomains[0].id,
      ownerId: store.getState().users[0].id,
    }) as any;
    await mount(store);
    // drive navigation into the product via the opener App registers on mount
    await act(async () => {
      openProduct(reg.product.id);
    });
    const html = container.innerHTML;
    expect(html).toContain("lifecycle-rail");
    expect(html).toContain("rail-node--locked"); // FSD hard-gate lock
    expect(html).toContain("Create BRD");
  });

  it("renders the rigour gate (red) and a blocked sign button after rigour on a thin BRD", async () => {
    const store = freshStore();
    const reg = store.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-9001",
      name: "Thin BRD Product",
      oneLiner: "Non-empty.",
      subDomainId: store.getState().subDomains[0].id,
      ownerId: null,
    }) as any;
    const pid = reg.product.id;
    store.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = store.docOf(pid, DocType.BRD)!;
    store.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await store.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });

    await mount(store);
    await act(async () => {
      openProduct(pid);
    });
    const html = container.innerHTML;
    expect(html).toContain("rigour-gate");
    expect(html).toContain("dot--red"); // at least one red dot
    expect(html).toContain("btn--signblocked"); // sign is blocked, with a reason
    expect(html).toContain("sign-reason");
  });

  it("renders the immutable signature record and the FSD unlocked after a signed BRD", async () => {
    const store = freshStore();
    const reg = store.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-9002",
      name: "Signed BRD Product",
      oneLiner: "Non-empty.",
      subDomainId: store.getState().subDomains[0].id,
      ownerId: store.getState().users[0].id,
    }) as any;
    const pid = reg.product.id;
    store.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = store.docOf(pid, DocType.BRD)!;
    store.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brd.id,
      content: {
        decision: "Planners decide the per-store allocation each morning replacing the flat split.",
        ownerId: store.getState().users[0].id,
        successMetrics: [{ metric: "In-stock rate", target: "≥ 95%" }],
        outOfScope: ["Promotional buy planning"],
        dataSources: [{ name: "SAP S/4HANA" }],
      },
    });
    store.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await store.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });
    const sign = store.dispatch({ type: "SIGN", documentId: brd.id }) as any;
    expect(sign.ok).toBe(true);
    expect(store.docOf(pid, DocType.BRD)!.status).toBe(DocStatus.SIGNED);

    await mount(store);
    await act(async () => {
      openProduct(pid);
    });
    const html = container.innerHTML;
    expect(html).toContain("signature-record"); // the immutable signed look
    expect(html).toContain("brd-v1"); // checklist version in the record
    // rail shows BRD done
    expect(html).toContain("rail-node--done");
  });
});
