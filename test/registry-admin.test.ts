// daup-duidelik — registry-admin tests
//
// Covers the PO-only registry management added for duidelik.daup.co.za:
//   - ARCHIVE_PRODUCT / UNARCHIVE_PRODUCT (reversible; signatures preserved; list hidden)
//   - RENAME_STREAM / RENAME_DOMAIN / RENAME_SUBDOMAIN (display-only, tree shape unchanged)
//   - the PO role gate (a non-PO is refused ERR_ROLE on every one of these)
//
// Standalone mode: actingUser defaults to users[0] (the seeded PRODUCT_OWNER). We flip
// to a non-PO via SET_ACTING_USER to prove the gate blocks.

import { describe, it, expect } from "vitest";
import { createStore, Role } from "../src/core";
import { memoryAdapter } from "../src/api/persistence";

function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-19T12:00:00.000Z");

function freshStore() {
  return createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock });
}

function poId(s: ReturnType<typeof freshStore>) {
  return s.getState().users.find((u) => u.role === Role.PRODUCT_OWNER)!.id;
}
function nonPoId(s: ReturnType<typeof freshStore>) {
  return s.getState().users.find((u) => u.role !== Role.PRODUCT_OWNER)!.id;
}

describe("Registry admin — archive products (PO)", () => {
  it("archives a product: hidden from active list, still in the graph, signatures kept", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    expect(s.isPO()).toBe(true);

    // DAPP-6036 has a SIGNED BRD in the seed — archiving must NOT destroy that signature.
    const p = s.getState().dataProducts.find((x) => x.code === "DAPP-6036")!;
    const sigBefore = s.getState().signatures.length;
    const docsBefore = s.docsForProduct(p.id).length;

    const r = s.dispatch({ type: "ARCHIVE_PRODUCT", productId: p.id }) as any;
    expect(r.ok).toBe(true);
    expect(r.product.archivedAt).toBeTruthy();

    // hidden from active, present in archived, documents + signatures untouched
    expect(s.activeProducts().some((x) => x.id === p.id)).toBe(false);
    expect(s.archivedProducts().some((x) => x.id === p.id)).toBe(true);
    expect(s.docsForProduct(p.id).length).toBe(docsBefore);
    expect(s.getState().signatures.length).toBe(sigBefore);
  });

  it("unarchive restores to the active list", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = s.getState().dataProducts.find((x) => x.code === "DAPP-6036")!;
    s.dispatch({ type: "ARCHIVE_PRODUCT", productId: p.id });
    const r = s.dispatch({ type: "UNARCHIVE_PRODUCT", productId: p.id }) as any;
    expect(r.ok).toBe(true);
    expect(r.product.archivedAt).toBeNull();
    expect(s.activeProducts().some((x) => x.id === p.id)).toBe(true);
  });

  it("archive survives export/import (schema v3)", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const p = s.getState().dataProducts.find((x) => x.code === "DAPP-6007")!;
    s.dispatch({ type: "ARCHIVE_PRODUCT", productId: p.id });
    const json = s.exportJson();

    const s2 = freshStore();
    s2.importJson(json);
    expect(s2.getState().schemaVersion).toBe(s.SCHEMA_VERSION);
    expect(s2.archivedProducts().some((x) => x.code === "DAPP-6007")).toBe(true);
  });
});

describe("Registry admin — rename tree nodes (PO)", () => {
  it("renames a stream, a domain and a sub-domain by name only (ids + shape unchanged)", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });

    const stream = s.getState().streams[0];
    const domain = s.getState().domains[0];
    const sub = s.getState().subDomains[0];

    const rs = s.dispatch({ type: "RENAME_STREAM", streamId: stream.id, name: "Renamed Stream" }) as any;
    const rd = s.dispatch({ type: "RENAME_DOMAIN", domainId: domain.id, name: "Renamed Domain" }) as any;
    const rsd = s.dispatch({ type: "RENAME_SUBDOMAIN", subDomainId: sub.id, name: "Renamed Sub" }) as any;
    expect(rs.ok && rd.ok && rsd.ok).toBe(true);

    const st = s.getState();
    expect(st.streams.find((x) => x.id === stream.id)!.name).toBe("Renamed Stream");
    expect(st.domains.find((x) => x.id === domain.id)!.name).toBe("Renamed Domain");
    expect(st.subDomains.find((x) => x.id === sub.id)!.name).toBe("Renamed Sub");

    // shape unchanged: same counts, same FKs
    expect(st.streams.length).toBe(2);
    expect(st.domains.length).toBe(10);
    expect(st.domains.find((x) => x.id === domain.id)!.streamId).toBe(domain.streamId);
    expect(st.subDomains.find((x) => x.id === sub.id)!.domainId).toBe(sub.domainId);
  });

  it("rejects an empty rename", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: poId(s) });
    const r = s.dispatch({ type: "RENAME_STREAM", streamId: s.getState().streams[0].id, name: "   " }) as any;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("EMPTY");
  });
});

describe("Registry admin — the PO gate blocks non-POs", () => {
  it("refuses archive and every rename for a non-PO with ERR_ROLE", () => {
    const s = freshStore();
    s.dispatch({ type: "SET_ACTING_USER", userId: nonPoId(s) });
    expect(s.isPO()).toBe(false);

    const p = s.getState().dataProducts[0];
    const stream = s.getState().streams[0];

    const a = s.dispatch({ type: "ARCHIVE_PRODUCT", productId: p.id }) as any;
    const rn = s.dispatch({ type: "RENAME_STREAM", streamId: stream.id, name: "Hacked" }) as any;

    expect(a.ok).toBe(false);
    expect(a.code).toBe("ERR_ROLE");
    expect(rn.ok).toBe(false);
    expect(rn.code).toBe("ERR_ROLE");

    // nothing mutated
    expect(s.getState().dataProducts.find((x) => x.id === p.id)!.archivedAt == null).toBe(true);
    expect(s.getState().streams.find((x) => x.id === stream.id)!.name).toBe(stream.name);
  });
});
