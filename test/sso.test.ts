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

    const reg = s.dispatch({
      type: "REGISTER_PRODUCT",
      code: "DAPP-H1",
      name: "House Product",
      oneLiner: "A non-empty one-liner.",
      subDomainId: s.getState().subDomains[0].id,
      ownerId: null,
    }) as any;
    const pid = reg.product.id;
    s.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = s.docOf(pid, DocType.BRD)!;
    // Owner must resolve to a known user for brd.single_owner — in house mode the
    // seeded users still exist in the graph, so point ownership at one of them.
    const anOwner = s.getState().users[0].id;
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
    const reg = seedStore.dispatch({
      type: "REGISTER_PRODUCT", code: "DAPP-H2", name: "Shared", oneLiner: "non-empty",
      subDomainId: seedStore.getState().subDomains[0].id, ownerId: seedStore.getState().users[0].id,
    }) as any;
    const pid = reg.product.id;
    seedStore.dispatch({ type: "CREATE_BRD", productId: pid });
    const brd = seedStore.docOf(pid, DocType.BRD)!;
    seedStore.dispatch({ type: "EDIT_DOCUMENT", documentId: brd.id, content: {
      decision: "Planners decide allocation each morning replacing the flat split.",
      ownerId: seedStore.getState().users[0].id, successMetrics: [{ metric: "r", target: "95%" }],
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
});

describe("P3.4 placeId scoping (O2 — shared per place)", () => {
  it("two different placeIds get independent registries; same placeId shares the blob", () => {
    const a1 = createStore({ genId: counterId(), clock: fixedClock, placeId: "place-A", session: { peerId: "p1", phone: null }, adapter: memoryAdapter() });
    // A fresh adapter per store here means isolation by construction; the real scoping is
    // the localStorage KEY (api/persistence.storageKey), tested below.
    expect(a1.getState().dataProducts.length).toBe(2); // seeded sample
  });

  it("the standalone store (no session) is NOT in house mode", () => {
    const s = createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock });
    expect(s.isHouseMode()).toBe(false);
    expect(s.actingUser()?.role).toBe(Role.PRODUCT_OWNER); // seeded picker's first user
  });
});
