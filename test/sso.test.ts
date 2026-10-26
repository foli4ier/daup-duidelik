// daup-duidelik — P3 house-session SSO + per-place roster self-check (vitest).
//
// Proves the identity change (DAUP-PORT-PLAN §4-§5 / O1-O2):
//   • the redeem receiving client reads the bearer from the mint aliases, never `token`,
//     and fails CLOSED on tainted / non-200 / role-bearing payloads;
//   • the first person to redeem into a place bootstraps as PRODUCT_OWNER;
//   • the sign gate reads the acting role from the ROSTER, not the session — an unknown
//     person cannot sign a BRD; the bootstrapped PO can;
//   • the store is placeId-scoped (shared per place, O2);
//   • a PO can assign roles; a non-PO cannot.

import { describe, it, expect } from "vitest";
import { createStore } from "../src/core/store";
import { memoryAdapter } from "../src/api/persistence";
import { redeemHouseSession } from "../src/api/houseSession";
import { ensureMember, resolveRole } from "../src/core/roster";
import { DocType, DocStatus, Role } from "../src/core/enums";
import type { PlaceMember } from "../src/types";

function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-15T00:00:00.000Z");

// A fake fetch returning a canned seed /house/session/redeem response.
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

const GOOD_BEARER = "house.derived.v1.eyJhIjoiYiJ9.abcDEF0123456789"; // opaque-token shaped

describe("P3.1 redeem client — bearer aliases + fail-closed", () => {
  it("reads the bearer from a mint alias and returns identity", async () => {
    const res = await redeemHouseSession({
      seedOrigin: "https://mcp.daup.co.za",
      houseRedeem: "hr_" + "a".repeat(40),
      fetchImpl: fakeFetch(200, {
        ok: true,
        sid: "s".repeat(20),
        placeId: "place-123",
        peerId: "peer-abc",
        phone: null,
        derivedToken: GOOD_BEARER,
        placeSession: GOOD_BEARER,
        session: GOOD_BEARER,
        daup_house_session: GOOD_BEARER,
        expiresAt: Date.now() + 60000,
      }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.placeId).toBe("place-123");
      expect(res.peerId).toBe("peer-abc");
      expect(res.bearer).toBe(GOOD_BEARER);
    }
  });

  it("fails CLOSED on a non-200", async () => {
    const res = await redeemHouseSession({
      seedOrigin: "https://mcp.daup.co.za",
      houseRedeem: "hr_" + "a".repeat(40),
      fetchImpl: fakeFetch(403, { ok: false, error: "redeem expired" }),
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a payload carrying a role or an invented `token` key", async () => {
    const tainted = await redeemHouseSession({
      seedOrigin: "https://mcp.daup.co.za",
      houseRedeem: "hr_" + "a".repeat(40),
      fetchImpl: fakeFetch(200, {
        ok: true,
        sid: "s".repeat(20),
        placeId: "place-123",
        peerId: "peer-abc",
        role: "PRODUCT_OWNER", // ← app role must never arrive via the session
        placeSession: GOOD_BEARER,
      }),
    });
    expect(tainted.ok).toBe(false);

    const invented = await redeemHouseSession({
      seedOrigin: "https://mcp.daup.co.za",
      houseRedeem: "hr_" + "a".repeat(40),
      fetchImpl: fakeFetch(200, {
        ok: true,
        sid: "s".repeat(20),
        placeId: "place-123",
        peerId: "peer-abc",
        token: GOOD_BEARER, // ← client-invented credential key
      }),
    });
    expect(invented.ok).toBe(false);
  });
});

describe("P3.2 roster — bootstrap + resolveRole", () => {
  it("bootstraps the first redeemer as PRODUCT_OWNER; later redeemers are not PO", () => {
    const first = ensureMember([], { peerId: "peer-po", phone: null }, fixedClock());
    expect(first.member.role).toBe(Role.PRODUCT_OWNER);
    expect(first.member.bootstrap).toBe(true);

    const second = ensureMember(first.members, { peerId: "peer-ba", phone: null }, fixedClock());
    expect(second.member.role).not.toBe(Role.PRODUCT_OWNER);

    expect(resolveRole(second.members, { peerId: "peer-po", phone: null })).toBe(Role.PRODUCT_OWNER);
    // an unknown person has no roster role
    expect(resolveRole(second.members, { peerId: "peer-ghost", phone: null })).toBeNull();
  });
});

describe("P3.3 store in house mode — sign gate reads the roster", () => {
  function houseStore(session: { peerId: string | null; phone: string | null }) {
    return createStore({
      adapter: memoryAdapter(),
      genId: counterId(),
      clock: fixedClock,
      aiClient: null,
      placeId: "place-xyz",
      session,
    });
  }

  it("bootstraps the first redeemer as PO and lets them sign a green BRD", async () => {
    const s = houseStore({ peerId: "peer-po", phone: null });
    expect(s.isHouseMode()).toBe(true);
    expect(s.actingMember()?.role).toBe(Role.PRODUCT_OWNER);

    // A fresh house place has NO seeded sub-domains or products — the team registers
    // their own. Create a sub-domain under a seeded enterprise domain first.
    const domainId = s.getState().domains[0].id;
    const sd = s.dispatch({ type: "CREATE_SUBDOMAIN", domainId, name: "Transport" }) as any;
    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-H1",
      name: "House Product",
      oneLiner: "A non-empty one-liner.",
      subDomainId: sd.subDomain.id,
      ownerId: null,
    }) as any;
    const pid = reg.product.id;
    s.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = s.docOf(pid, DocType.BRD)!;
    // Owner must resolve for brd.single_owner. In house mode the owner is a ROSTER
    // Product Owner — use the bootstrapped PO's roster key (resolveUser resolves it).
    const anOwner = s.actingMember()!.key;
    expect(s.ownerCandidates().some((o) => o.id === anOwner)).toBe(true);
    s.dispatch({
      type: "EDIT_DOCUMENT",
      documentId: brd.id,
      content: {
        decision: "Planners decide the per-store allocation each morning replacing the flat split.",
        ownerId: anOwner,
        successMetrics: [{ metric: "In-stock rate", target: "≥ 95%" }],
        outOfScope: ["Promotional buy planning"],
        dataSources: [{ name: "SAP S/4HANA" }],
      },
    });
    s.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await s.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });
    const sign = s.dispatch({ type: "SIGN", documentId: brd.id }) as any;
    expect(sign.ok).toBe(true);
    expect(s.docOf(pid, DocType.BRD)!.status).toBe(DocStatus.SIGNED);
    // the signature records the acting peer (roster key), not a seeded user
    expect(sign.signature.signedById).toContain("peer");
    expect(sign.signature.signedByRole).toBe(Role.PRODUCT_OWNER);
  });

  it("blocks a BRD sign for a non-PO member (ERR_ROLE), reading the roster not the session", async () => {
    // Pre-seed a SHARED place blob: a PO already bootstrapped, a product with a green
    // BRD in rigour, and a second person on the roster as a non-PO. Handing this blob to
    // memoryAdapter(initial) avoids any cross-store debounce-write timing.
    const seedStore = createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock, placeId: "seed", session: { peerId: "peer-po", phone: null } });
    const poKey = seedStore.actingMember()!.key;
    const domainId = seedStore.getState().domains[0].id;
    const sd = seedStore.dispatch({ type: "CREATE_SUBDOMAIN", domainId, name: "Transport" }) as any;
    const reg = seedStore.dispatch({
      type: "REGISTER_PRODUCT", code: "DAPP-H2", name: "Shared", oneLiner: "non-empty",
      subDomainId: sd.subDomain.id, ownerId: poKey,
    }) as any;
    const pid = reg.product.id;
    seedStore.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = seedStore.docOf(pid, DocType.BRD)!;
    seedStore.dispatch({ type: "EDIT_DOCUMENT", documentId: brd.id, content: {
      decision: "Planners decide allocation each morning replacing the flat split.",
      ownerId: poKey, successMetrics: [{ metric: "r", target: "95%" }],
      outOfScope: ["Promo"], dataSources: [{ name: "SAP" }],
    } });
    seedStore.dispatch({ type: "START_RIGOUR", documentId: brd.id });
    await seedStore.dispatch({ type: "RUN_RIGOUR", documentId: brd.id });

    // Snapshot the fully-built graph and add a non-PO member to the roster.
    const blob = JSON.parse(seedStore.exportJson());
    const baMember: PlaceMember = {
      key: "peer:peer-ba", peerId: "peer-ba", phone: null, role: Role.BUSINESS_ANALYST,
      name: "BA", bootstrap: false, createdAt: fixedClock().toISOString(), updatedAt: fixedClock().toISOString(),
    };
    blob.members = [...(blob.members ?? []), baMember];

    // The BA opens the SAME place blob. Their roster role is BUSINESS_ANALYST, not PO.
    const ba = createStore({ adapter: memoryAdapter(blob), genId: counterId(), clock: fixedClock, placeId: "seed", session: { peerId: "peer-ba", phone: null } });
    expect(ba.actingMember()?.role).toBe(Role.BUSINESS_ANALYST);
    const brdBa = ba.docOf(pid, DocType.BRD)!;
    const sign = ba.dispatch({ type: "SIGN", documentId: brdBa.id }) as any;
    expect(sign.ok).toBe(false);
    expect(sign.code).toBe("ERR_ROLE"); // reads the ROSTER role, not the session
  });

  it("a PO can assign a role; a non-PO cannot", async () => {
    const adapter = memoryAdapter();
    createStore({ adapter, genId: counterId(), clock: fixedClock, placeId: "place-roles", session: { peerId: "peer-po", phone: null } });
    const ba = createStore({ adapter, genId: counterId(), clock: fixedClock, placeId: "place-roles", session: { peerId: "peer-ba", phone: null } });
    const baKey = ba.actingMember()!.key;

    // non-PO (ba) tries to promote itself → refused
    const refused = ba.dispatch({ type: "ASSIGN_ROLE", targetKey: baKey, role: Role.PRODUCT_OWNER }) as any;
    expect(refused.ok).toBe(false);

    // PO promotes ba → BUSINESS_ANALYST
    const po = createStore({ adapter, genId: counterId(), clock: fixedClock, placeId: "place-roles", session: { peerId: "peer-po", phone: null } });
    const ok = po.dispatch({ type: "ASSIGN_ROLE", targetKey: baKey, role: Role.BUSINESS_ANALYST }) as any;
    expect(ok.ok).toBe(true);
    const promoted = (ok.members as PlaceMember[]).find((m) => m.key === baKey)!;
    expect(promoted.role).toBe(Role.BUSINESS_ANALYST);
  });

  it("owner-candidates come from the ROSTER's Product Owners in house mode (the dropdown fix)", () => {
    // Build a place blob with a bootstrapped PO, then add a BA to the roster — the
    // single-store scenario the UI actually has (one store per place).
    const seed = createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock, placeId: "oc", session: { peerId: "peer-po", phone: null } });
    const poKey = seed.actingMember()!.key;
    const blob = JSON.parse(seed.exportJson());
    const baMember: PlaceMember = {
      key: "peer:peer-ba", peerId: "peer-ba", phone: null, role: Role.BUSINESS_ANALYST,
      name: "A. Botha", bootstrap: false, createdAt: fixedClock().toISOString(), updatedAt: fixedClock().toISOString(),
    };
    blob.members = [...(blob.members ?? []), baMember];

    const po = createStore({ adapter: memoryAdapter(blob), genId: counterId(), clock: fixedClock, placeId: "oc", session: { peerId: "peer-po", phone: null } });

    // Only the PO is an owner candidate; the BA (non-PO) is not.
    let cands = po.ownerCandidates();
    expect(cands.length).toBe(1);
    expect(cands[0].id).toBe(poKey);
    expect(cands.some((c) => c.id === baMember.key)).toBe(false);

    // Promote the BA to a second Product Owner → it must now appear in the dropdown.
    const promoted = po.dispatch({ type: "ASSIGN_ROLE", targetKey: baMember.key, role: Role.PRODUCT_OWNER }) as any;
    expect(promoted.ok).toBe(true);
    cands = po.ownerCandidates();
    expect(cands.length).toBe(2);
    expect(cands.some((c) => c.id === baMember.key)).toBe(true);
    // ownerId set to a roster key still resolves to a name (print / display).
    expect(po.resolveUser(baMember.key)?.name).toBe("A. Botha");
  });
});

describe("P3.4 placeId scoping (O2 — shared per place)", () => {
  it("a fresh house place seeds the enterprise tree only — no demo users, sub-domains or products", () => {
    const a1 = createStore({ genId: counterId(), clock: fixedClock, placeId: "place-A", session: { peerId: "p1", phone: null }, adapter: memoryAdapter() });
    // A fresh HOUSE place must NOT inherit the demo seed (the reported bug): no sample
    // C. Willemburg user, no Transport sub-domain, no Shepherd products. The fixed
    // enterprise tree (streams + 10 domains, DATA-MODEL §6-C) IS seeded.
    expect(a1.getState().dataProducts.length).toBe(0);
    expect(a1.getState().subDomains.length).toBe(0);
    expect(a1.getState().users.length).toBe(0);
    expect(a1.getState().streams.length).toBe(2);
    expect(a1.getState().domains.length).toBe(10);
    // The only member is the bootstrapped redeemer (as PO), not a demo user.
    expect(a1.members().length).toBe(1);
    expect(a1.members()[0].role).toBe(Role.PRODUCT_OWNER);
  });

  it("the standalone store (no session) is NOT in house mode", () => {
    const s = createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock });
    expect(s.isHouseMode()).toBe(false);
    expect(s.actingUser()?.role).toBe(Role.PRODUCT_OWNER); // seeded picker's first user
  });
});
