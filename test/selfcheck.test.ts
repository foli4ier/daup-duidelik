// daup-duidelik — core engine self-check, ported to vitest.
//
// This is the P1 proof: the governance gates ACTUALLY BLOCK and the state machine
// obeys LIFECYCLE §6 — before any UI exists. Ported assertion-for-assertion from the
// v1 app/test/selfcheck.mjs so parity with the proven engine is auditable.

import { describe, it, expect } from "vitest";
import {
  createStore,
  createAiClient,
  NULL_AI_CLIENT,
  LifecycleStage,
  DocStatus,
  DocType,
  Score,
  Role,
  ERR,
} from "../src/core";
import { memoryAdapter } from "../src/api/persistence";
import { runRigour } from "../src/core/rigour";
import { signDocument } from "../src/core/signing";
import type { RigourCheck } from "../src/types";

// Deterministic id minter so seeds are reproducible across runs.
function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-14T12:00:00.000Z");

function freshStore(aiClient: any = null) {
  return createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock, aiClient });
}

// Shared fixtures produced in section 3, consumed in section 5.
let thinChecks: RigourCheck[];
let goodChecks: RigourCheck[];

describe("1. Seed + persistence", () => {
  it("seeds streams, domains, users, products and round-trips export/import", () => {
    const s = freshStore();
    const st = s.getState();
    expect(st.streams.length).toBe(2);
    expect(st.domains.length).toBe(10);
    expect(st.users.length).toBe(4);
    expect(st.users.some((u) => u.role === Role.PRODUCT_OWNER)).toBe(true);
    expect(st.dataProducts.length).toBe(2);

    const json = s.exportJson();
    const s2 = freshStore();
    s2.importJson(json);
    expect(s2.getState().dataProducts.length).toBe(2);
  });
});

describe("2. Hard gate — no FSD until BRD signed", () => {
  it("rejects CREATE_FSD while the BRD is unsigned", () => {
    const s = freshStore();
    const p2 = s.getState().dataProducts.find((p) => p.code === "DAPP-6007")!;
    const r = s.dispatch({ type: "CREATE_FSD", productId: p2.id }) as any;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BRD_NOT_SIGNED");

    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-7000",
      name: "Test Product",
      oneLiner: "A test one-liner that is non-empty.",
      subDomainId: s.getState().subDomains[0].id,
      ownerId: s.getState().users[0].id,
    }) as any;
    expect(reg.ok).toBe(true);
    expect(reg.product.stage).toBe(LifecycleStage.ONE_LINER);

    const brd = s.dispatch({ type: "CREATE_BRD", productId: reg.product.id }) as any;
    expect(brd.ok).toBe(true);
    expect(brd.product.stage).toBe(LifecycleStage.BRD);

    const fsdBlocked = s.dispatch({ type: "CREATE_FSD", productId: reg.product.id }) as any;
    expect(fsdBlocked.ok).toBe(false);
    expect(fsdBlocked.code).toBe("BRD_NOT_SIGNED");
  });
});

describe("3. Rigour deterministic floor (AI absent)", () => {
  it("blocks a thin BRD and passes the worked example with no AI", async () => {
    // Counter-example from BRD-template §5 — fluent but thin → must have RED.
    const thinBrd = {
      id: "d-thin",
      type: DocType.BRD,
      status: DocStatus.IN_RIGOUR,
      content: {
        decision: "Improve visibility.",
        ownerId: null,
        successMetrics: [{ metric: "Better visibility", target: "" }],
        outOfScope: [],
        dataSources: [{ name: "various systems" }],
      },
    } as any;
    const ctx = {
      content: thinBrd.content,
      product: { ownerId: null },
      resolveUser: () => null,
      placementIntact: true,
      signedBrdKeys: [],
      now: fixedClock(),
    };
    const res = await runRigour(thinBrd, ctx, { aiClient: NULL_AI_CLIENT, genId: counterId() });
    thinChecks = res.checks;
    expect(res.deterministicOnly).toBe(true);
    expect(res.rollup).toBe(Score.RED);
    const reds = res.checks.filter((c) => c.score === Score.RED).map((c) => c.key);
    expect(reds).toContain("brd.single_owner");
    expect(reds).toContain("brd.scope_boundary");

    // Worked example from BRD-template §4 — must be all GREEN.
    const goodBrd = {
      id: "d-good",
      type: DocType.BRD,
      status: DocStatus.IN_RIGOUR,
      content: {
        decision:
          "Replenishment planners decide the per-store allocation of each constrained SKU each morning, replacing the flat split.",
        ownerId: "u-po",
        successMetrics: [{ metric: "In-stock rate", target: "≥ 95%", by: "FY26 Q2" }],
        outOfScope: ["Promotional buy planning"],
        dataSources: [{ name: "SAP S/4HANA — Stock on Hand" }],
      },
    } as any;
    const ctx2 = {
      content: goodBrd.content,
      product: { ownerId: "u-po" },
      resolveUser: (id: string) => (id === "u-po" ? { id } : null),
      placementIntact: true,
      signedBrdKeys: [],
      now: fixedClock(),
    };
    const res2 = await runRigour(goodBrd, ctx2, { aiClient: NULL_AI_CLIENT, genId: counterId() });
    goodChecks = res2.checks;
    expect(res2.rollup).toBe(Score.GREEN);
  });
});

describe("4. AI refinement — stricter-wins clamp", () => {
  it("cannot upgrade a code-RED to pass", async () => {
    const cheatingAi = createAiClient({
      transport: async ({ payload }: any) =>
        payload.items.map((i: any) => ({ key: i.key, score: Score.GREEN, reason: "AI says fine" })),
    });
    const thinBrd = {
      id: "d-thin2",
      type: DocType.BRD,
      status: DocStatus.IN_RIGOUR,
      content: { decision: "", ownerId: null, successMetrics: [], outOfScope: [], dataSources: [] },
    } as any;
    const ctx = {
      content: thinBrd.content,
      product: { ownerId: null },
      resolveUser: () => null,
      placementIntact: true,
      signedBrdKeys: [],
      now: fixedClock(),
    };
    const res = await runRigour(thinBrd, ctx, { aiClient: cheatingAi, genId: counterId() });
    expect(res.deterministicOnly).toBe(false);
    expect(res.rollup).toBe(Score.RED);
  });
});

describe("5. GATE S error contract", () => {
  it("fires every §5 error code and signs on a clean gate", () => {
    const po = { id: "u-po", role: Role.PRODUCT_OWNER };
    const ba = { id: "u-ba", role: Role.BUSINESS_ANALYST };

    // not in rigour
    const draftDoc = { id: "d1", type: DocType.BRD, status: DocStatus.DRAFT, content: {} } as any;
    expect((signDocument(draftDoc, [], po) as any).code).toBe(ERR.ERR_NOT_IN_RIGOUR);

    // red blocks
    const redDoc = { id: "d2", type: DocType.BRD, status: DocStatus.IN_RIGOUR, content: {} } as any;
    const redRes = signDocument(redDoc, thinChecks.map((c) => ({ ...c, documentId: "d2" })), po) as any;
    expect(redRes.code).toBe(ERR.ERR_RED_BLOCKS);
    expect(redRes.items.length).toBeGreaterThan(0);

    // amber needs note
    const amberChecks = [
      { key: "brd.decision_stated", score: Score.GREEN, reason: "" },
      { key: "brd.measurable_success", score: Score.AMBER, reason: "no target", overrideNote: null },
    ] as any;
    const amberDoc = { id: "d3", type: DocType.BRD, status: DocStatus.IN_RIGOUR, content: {} } as any;
    expect((signDocument(amberDoc, amberChecks, po) as any).code).toBe(ERR.ERR_AMBER_NEEDS_NOTE);

    // amber WITH note + PO → passes
    const amberNoted = amberChecks.map((c: any) =>
      c.score === Score.AMBER ? { ...c, overrideNote: "interim proxy agreed" } : c,
    );
    const passRes = signDocument({ ...amberDoc, checklistVersion: "brd-v1" }, amberNoted, po) as any;
    expect(passRes.ok).toBe(true);

    // role gate: BA cannot sign a BRD even all-green
    const greenChecks = goodChecks.map((c) => ({ ...c }));
    const roleRes = signDocument(
      { id: "d4", type: DocType.BRD, status: DocStatus.IN_RIGOUR, content: {}, checklistVersion: "brd-v1" } as any,
      greenChecks,
      ba,
    ) as any;
    expect(roleRes.code).toBe(ERR.ERR_ROLE);

    // FSD: any role may sign
    const fsdRes = signDocument(
      { id: "d5", type: DocType.FSD, status: DocStatus.IN_RIGOUR, content: {}, checklistVersion: "fsd-v1" } as any,
      [{ key: "x", score: Score.GREEN, reason: "" }] as any,
      ba,
    ) as any;
    expect(fsdRes.ok).toBe(true);
  });
});

describe("6. Immutable signature", () => {
  it("snapshots role + checklist + hash, and the hash tracks content", () => {
    const po = { id: "u-po", role: Role.PRODUCT_OWNER };
    const doc = {
      id: "d6",
      type: DocType.BRD,
      status: DocStatus.IN_RIGOUR,
      content: { decision: "x" },
      checklistVersion: "brd-v1",
    } as any;
    const checks = [
      { key: "brd.decision_stated", score: Score.GREEN, reason: "ok", overrideNote: null },
    ] as any;
    const res = signDocument(doc, checks, po, { genId: counterId() }) as any;
    expect(res.ok).toBe(true);
    expect(res.signature.signedByRole).toBe(Role.PRODUCT_OWNER);
    expect(res.signature.checklistVersion).toBe("brd-v1");
    expect(Array.isArray(res.signature.checklistSnapshot)).toBe(true);
    expect(res.signature.checklistSnapshot.length).toBe(1);
    expect(typeof res.signature.documentHash).toBe("string");
    expect(res.signature.documentHash.length).toBeGreaterThan(0);

    const h1 = res.signature.documentHash;
    const res2 = signDocument({ ...doc, content: { decision: "y" } }, checks, po, { genId: counterId() }) as any;
    expect(res2.signature.documentHash).not.toBe(h1);

    // frozen (immutable)
    let threw = false;
    try {
      res.signature.signedById = "tamper";
    } catch {
      threw = true;
    }
    expect(threw || res.signature.signedById === "u-po").toBe(true);
  });
});

describe("7. End-to-end — sign BRD unlocks FSD", () => {
  it("signs a green BRD and unlocks FSD creation", async () => {
    const s = freshStore();
    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-8000",
      name: "E2E Product",
      oneLiner: "A non-empty one-liner for the e2e path.",
      subDomainId: s.getState().subDomains[0].id,
      ownerId: s.getState().users[0].id,
    }) as any;
    const pid = reg.product.id;
    s.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = s.docOf(pid, DocType.BRD)!;
    s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brd.id,
      content: {
        decision: "Planners decide the per-store allocation each morning replacing the flat split.",
        ownerId: s.getState().users[0].id,
        successMetrics: [{ metric: "In-stock rate", target: "≥ 95%" }],
        outOfScope: ["Promotional buy planning"],
        dataSources: [{ name: "SAP S/4HANA" }],
      },
    });
    s.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    const rr = (await s.dispatch({ type: "RUN_RIGOUR", documentId: brd.id })) as any;
    expect(rr.rollup).toBe(Score.GREEN);

    const signRes = s.dispatch({ type: "SIGN", documentId: brd.id }) as any;
    expect(signRes.ok).toBe(true);
    expect(s.docOf(pid, DocType.BRD)!.status).toBe(DocStatus.SIGNED);

    const fsd = s.dispatch({ type: "CREATE_FSD", productId: pid }) as any;
    expect(fsd.ok).toBe(true);
    expect(fsd.product.stage).toBe(LifecycleStage.FSD);
  });
});

describe("8. Invalidation cascade", () => {
  it("editing a signed BRD pulls the FSD back to DRAFT and the stage back to BRD", async () => {
    const s = freshStore();
    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-8100",
      name: "Cascade Product",
      oneLiner: "Non-empty one-liner.",
      subDomainId: s.getState().subDomains[0].id,
      ownerId: s.getState().users[0].id,
    }) as any;
    const pid = reg.product.id;
    s.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = s.docOf(pid, DocType.BRD)!;
    s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brd.id,
      content: {
        decision: "Planners decide allocation each morning replacing the flat split.",
        ownerId: s.getState().users[0].id,
        successMetrics: [{ metric: "rate", target: "≥ 95%" }],
        outOfScope: ["Promo"],
        dataSources: [{ name: "SAP" }],
      },
    });
    s.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await s.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });
    s.dispatch({ type: "SIGN", documentId: brd.id });
    s.dispatch({ type: "CREATE_FSD", productId: pid });
    expect(s.product(pid)!.stage).toBe(LifecycleStage.FSD);

    const brdAfter = s.docOf(pid, DocType.BRD)!;
    const editRes = s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brdAfter.id,
      content: { ...brdAfter.content, decision: "changed decision" },
    }) as any;
    expect(editRes.invalidation).not.toBeNull();
    expect(s.docOf(pid, DocType.BRD)!.status).toBe(DocStatus.DRAFT);
    expect(s.docOf(pid, DocType.FSD)!.status).toBe(DocStatus.DRAFT);
    expect(s.product(pid)!.stage).toBe(LifecycleStage.BRD);
    expect(/re-rigoured/.test(editRes.invalidation.banner)).toBe(true);
  });
});

describe("9. QRG publish (no gate)", () => {
  it("publishes a QRG and moves the product to LIVE", async () => {
    const s = freshStore();
    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-8200",
      name: "QRG Product",
      oneLiner: "x non-empty",
      subDomainId: s.getState().subDomains[0].id,
      ownerId: s.getState().users[0].id,
    }) as any;
    const pid = reg.product.id;
    s.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = s.docOf(pid, DocType.BRD)!;
    s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brd.id,
      content: {
        decision: "Planners decide allocation each morning.",
        ownerId: s.getState().users[0].id,
        successMetrics: [{ metric: "r", target: "95%" }],
        outOfScope: ["Promo"],
        dataSources: [{ name: "SAP" }],
      },
    });
    s.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await s.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });
    s.dispatch({ type: "SIGN", documentId: brd.id });
    s.dispatch({ type: "CREATE_FSD", productId: pid });
    const fsd = s.docOf(pid, DocType.FSD)!;
    s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: fsd.id,
      content: {
        requirements: [{ id: "FR-1", text: "t", brdRef: "decision" }],
        entities: [
          { name: "e1", grain: "one row per x", relationships: [{ to: "e2", cardinality: "1:N" }] },
          { name: "e2", grain: "one row per y" },
        ],
        erd: { format: "mermaid", source: "erDiagram\n e1 ||--o{ e2 : r" },
        nonFunctionals: { refresh: "daily", retention: "24m", access: "planners" },
      },
    });
    s.dispatch({ type: "START_RIGOUR", documentId: fsd.id });
    await s.dispatch({ type: "RUN_RIGOUR", documentId: fsd.id });
    const fsdSign = s.dispatch({ type: "SIGN", documentId: fsd.id }) as any;
    expect(fsdSign.ok).toBe(true);
    const qrg = s.dispatch({ type: "CREATE_QRG", productId: pid }) as any;
    expect(qrg.ok).toBe(true);
    expect(s.product(pid)!.stage).toBe(LifecycleStage.QRG);
    const pub = s.dispatch({ type: "PUBLISH_QRG", productId: pid }) as any;
    expect(pub.ok).toBe(true);
    expect(s.product(pid)!.stage).toBe(LifecycleStage.LIVE);
    expect(s.docOf(pid, DocType.QRG)!.status).toBe(DocStatus.PUBLISHED);
  });
});

describe("10. Override-note survives re-score only while still AMBER", () => {
  it("preserves the note while AMBER and clears it when the item flips to GREEN", async () => {
    const amberContent = {
      decision: "Planners decide allocation each morning.",
      ownerId: "u-po",
      successMetrics: [{ metric: "rate", target: "better" }],
      outOfScope: ["Promo"],
      dataSources: [{ name: "SAP" }],
    };
    const doc = { id: "d-ov", type: DocType.BRD, status: DocStatus.IN_RIGOUR, content: amberContent } as any;
    const ctx = {
      content: amberContent,
      product: { ownerId: "u-po" },
      resolveUser: () => ({ id: "u-po" }),
      placementIntact: true,
      signedBrdKeys: [],
      now: fixedClock(),
    };
    const first = await runRigour(doc, ctx, { aiClient: NULL_AI_CLIENT, genId: counterId() });
    const amber = first.checks.find((c) => c.key === "brd.measurable_success")!;
    expect(amber.score).toBe(Score.AMBER);
    const noted = first.checks.map((c) =>
      c.key === "brd.measurable_success" ? { ...c, overrideNote: "interim", overriddenById: "u-po" } : c,
    );
    const second = await runRigour(doc, ctx, { aiClient: NULL_AI_CLIENT, priorChecks: noted, genId: counterId() });
    const amber2 = second.checks.find((c) => c.key === "brd.measurable_success")!;
    expect(amber2.overrideNote).toBe("interim");

    const fixed = { ...amberContent, successMetrics: [{ metric: "rate", target: "≥ 95%" }] };
    const ctx3 = { ...ctx, content: fixed };
    const third = await runRigour({ ...doc, content: fixed }, ctx3, {
      aiClient: NULL_AI_CLIENT,
      priorChecks: noted,
      genId: counterId(),
    });
    const green = third.checks.find((c) => c.key === "brd.measurable_success")!;
    expect(green.score).toBe(Score.GREEN);
    expect(green.overrideNote).toBeNull();
  });
});
