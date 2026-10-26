// daup-duidelik — import / unlock store-intent tests
//
// Proves the new mutation surface behaves to the lifecycle + rigour contracts:
//   IMPORT_DOCUMENT  — applies content via EDIT_DOCUMENT, so a SIGNED target re-opens
//                      to DRAFT and cascades (never forges a signature).
//   UNLOCK_DOCUMENT  — PO-gated; re-opens a SIGNED doc to DRAFT + invalidation cascade;
//                      a non-PO is refused ERR_ROLE and nothing changes.
//   IMPORT_GLOSSARY  — merges terms by case-insensitive name (add new, update existing).

import { describe, it, expect } from "vitest";
import { createStore, Role } from "../src/core";
import { memoryAdapter } from "../src/api/persistence";
import { DocType, DocStatus, LifecycleStage } from "../src/core/enums";

function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-26T12:00:00.000Z");
function freshStore() {
  return createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock });
}
function poId(s: ReturnType<typeof freshStore>) {
  return s.getState().users.find((u) => u.role === Role.PRODUCT_OWNER)!.id;
}
function nonPoId(s: ReturnType<typeof freshStore>) {
  return s.getState().users.find((u) => u.role !== Role.PRODUCT_OWNER)!.id;
}
// DAPP-6036 ships with a SIGNED BRD (stage FSD, FSD DRAFT) — the invalidation subject.
function signedBrdProduct(s: ReturnType<typeof freshStore>) {
  return s.getState().dataProducts.find((p) => p.code === "DAPP-6036")!;
}

describe("UNLOCK_DOCUMENT — owner re-opens a signed document", () => {
  it("PO unlock drops the signed BRD to DRAFT and pulls the product stage back to BRD", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = signedBrdProduct(s);
    expect(p.stage).toBe(LifecycleStage.FSD);
    const brd = s.docOf(p.id, DocType.BRD)!;
    expect(brd.status).toBe(DocStatus.SIGNED);

    const r = s.dispatch({ type: "UNLOCK_DOCUMENT", documentId: brd.id }) as any;
    expect(r.ok).toBe(true);
    // BRD re-opened to DRAFT
    expect(s.docOf(p.id, DocType.BRD)!.status).toBe(DocStatus.DRAFT);
    // stage pulled back to BRD
    expect(s.product(p.id)!.stage).toBe(LifecycleStage.BRD);
    // downstream FSD forced to DRAFT (invalidation cascade)
    expect(s.docOf(p.id, DocType.FSD)!.status).toBe(DocStatus.DRAFT);
    expect(r.invalidation).toBeTruthy();
  });

  it("a non-PO cannot unlock — ERR_ROLE, nothing changes", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: nonPoId(s) });
    const p = signedBrdProduct(s);
    const brd = s.docOf(p.id, DocType.BRD)!;

    const r = s.dispatch({ type: "UNLOCK_DOCUMENT", documentId: brd.id }) as any;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ERR_ROLE");
    // unchanged
    expect(s.docOf(p.id, DocType.BRD)!.status).toBe(DocStatus.SIGNED);
    expect(s.product(p.id)!.stage).toBe(LifecycleStage.FSD);
  });

  it("refuses to unlock a document that is not SIGNED", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = s.getState().dataProducts.find((x) => x.code === "DAPP-6007")!; // BRD DRAFT
    const brd = s.docOf(p.id, DocType.BRD)!;
    const r = s.dispatch({ type: "UNLOCK_DOCUMENT", documentId: brd.id }) as any;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_SIGNED");
  });
});

describe("IMPORT_DOCUMENT — applying an artifact never forges a signature", () => {
  it("importing into a SIGNED BRD re-opens it to DRAFT and writes the imported content", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = signedBrdProduct(s);
    const brd = s.docOf(p.id, DocType.BRD)!;
    expect(brd.status).toBe(DocStatus.SIGNED);

    const content = { decision: "Imported decision text.", outOfScope: ["promos"] };
    const r = s.dispatch({ type: "IMPORT_DOCUMENT", productId: p.id, docType: DocType.BRD, content }) as any;
    expect(r.ok).toBe(true);

    const after = s.docOf(p.id, DocType.BRD)!;
    expect(after.status).toBe(DocStatus.DRAFT); // re-opened, not still SIGNED
    expect((after.content as any).decision).toBe("Imported decision text.");
    // stage pulled back, FSD invalidated
    expect(s.product(p.id)!.stage).toBe(LifecycleStage.BRD);
    expect(s.docOf(p.id, DocType.FSD)!.status).toBe(DocStatus.DRAFT);
  });

  it("importing a BRD into a product with no BRD yet creates it as DRAFT with the content", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    // register a brand-new ONE_LINER product with no documents
    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-7000",
      subDomainId: s.getState().subDomains[0].id,
      name: "Fresh Product",
      oneLiner: "A fresh one-liner.",
      ownerId: poId(s),
    }) as any;
    const pid = reg.product.id;
    expect(s.docOf(pid, DocType.BRD)).toBeNull();

    const content = { decision: "Imported into a fresh product." };
    const r = s.dispatch({ type: "IMPORT_DOCUMENT", productId: pid, docType: DocType.BRD, content }) as any;
    expect(r.ok).toBe(true);
    const brd = s.docOf(pid, DocType.BRD)!;
    expect(brd.status).toBe(DocStatus.DRAFT);
    expect((brd.content as any).decision).toBe("Imported into a fresh product.");
  });

  it("refuses to import an FSD into a product whose BRD is not signed (hard gate honoured)", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = s.getState().dataProducts.find((x) => x.code === "DAPP-6007")!; // BRD DRAFT, no FSD
    expect(s.docOf(p.id, DocType.FSD)).toBeNull();
    const r = s.dispatch({ type: "IMPORT_DOCUMENT", productId: p.id, docType: DocType.FSD, content: { requirements: [] } }) as any;
    expect(r.ok).toBe(false);
    // createFsd throws BRD_NOT_SIGNED — surfaced as the error code
    expect(r.code).toBe("BRD_NOT_SIGNED");
  });
});

describe("IMPORT_GLOSSARY — merge by term name", () => {
  it("adds new terms and updates existing ones (case-insensitive) without duplicating", () => {
    const s = freshStore();
    const p = s.getState().dataProducts[0];
    s.dispatch({ type: "ADD_GLOSSARY_TERM", productId: p.id, term: "OBD", definition: "Old definition." });

    const r = s.dispatch({
      type: "IMPORT_GLOSSARY",
      productId: p.id,
      terms: [
        { term: "obd", definition: "Outbound Delivery (updated)." }, // same term, different case → update
        { term: "Grain", definition: "The level of one row." }, // new
      ],
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);

    const terms = s.glossaryForProduct(p.id);
    expect(terms).toHaveLength(2); // not 3 — OBD merged, not duplicated
    expect(terms.find((t) => t.term.toLowerCase() === "obd")!.definition).toBe("Outbound Delivery (updated).");
    expect(terms.some((t) => t.term === "Grain")).toBe(true);
  });
});
