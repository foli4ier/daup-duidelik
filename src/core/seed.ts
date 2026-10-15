// duidelik — seed data (DATA-MODEL.md §6-C/D; faithful to the approved mockups)
//
// Streams and the 10 enterprise domains are a FIXED enterprise list (seeded, not
// user-created in v1). Users are a seed list for the "acting as" picker (no auth).
// A small sample tree (Supply Chain & Inventory › Transport + two Shepherd products)
// mirrors design/screen-registry-home.html so the registry is populated on first boot.
//
// ids are MINTED at seed time (ULIDs) so references are internally consistent; the
// human DataProduct.code values match the mockups ("DAPP-6036", "DAPP-6007").
//
// Ported verbatim (logic) from app/src/seed.js; JS→TS typing only. NOTE: under the
// daup house session (P3, DAUP-PORT-PLAN §5) the demo users are dropped and identity
// comes from the redeemed session; the P1 port keeps the picker seed unchanged so the
// vitest self-check (2 streams · 10 domains · 4 users · 2 products) still passes.
// The store key becomes placeId-scoped in P3 — that is api/persistence.ts, not here.

import { ulid } from "./ids";
import { LifecycleStage, DocStatus, DocType, Role } from "./enums";
import type { StoreGraph, User, Stream, Domain, SubDomain, DataProduct } from "../types";

/**
 * Build the seed store graph. Pass a deterministic id minter for reproducible seeds
 * (used by the self-check); defaults to real ULIDs.
 */
export function buildSeed(genId: () => string = ulid, now: Date = new Date()): StoreGraph {
  const iso = now.toISOString();
  const id = () => genId();

  // ── Users (DATA-MODEL §6-D; names from partial-acting-as.html) ──
  const users: User[] = [
    { id: id(), name: "C. Willemburg", role: Role.PRODUCT_OWNER },
    { id: id(), name: "T. Mokoena", role: Role.PRODUCT_MANAGER },
    { id: id(), name: "A. Botha", role: Role.BUSINESS_ANALYST },
    { id: id(), name: "J. van der Merwe", role: Role.FUNCTIONAL_ANALYST },
  ];
  const po = users[0];

  // ── Streams (fixed enterprise list; two from the mockups) ──
  const streams: Stream[] = [
    { id: id(), name: "Stream 1 · Supply, Stock & Store", order: 1 },
    { id: id(), name: "Stream 2 · Commercial, Finance & Gov", order: 2 },
  ];

  // ── The 10 enterprise semantic domains (CONCEPT §2). Split across the two
  //    streams; names are the enterprise domain set. ──
  const DOMAIN_NAMES: [string, number][] = [
    ["Merchandising & Vendor", 0],
    ["Supply Chain & Inventory", 0],
    ["Store Operations", 0],
    ["Customer & Loyalty", 1],
    ["Commercial Growth", 1],
    ["Finance", 1],
    ["HR & People", 1],
    ["Governance & Risk", 1],
    ["Marketing & Media", 1],
    ["Property & Assets", 1],
  ];
  const domains: Domain[] = DOMAIN_NAMES.map(([name, streamIdx], i) => ({
    id: id(),
    streamId: streams[streamIdx].id,
    name,
    description: null,
    order: i + 1,
  }));
  const domainByName: Record<string, Domain> = Object.fromEntries(domains.map((d) => [d.name, d]));

  // ── Sub-domains (seeded sample under Supply Chain & Inventory, per mockup) ──
  const scInventory = domainByName["Supply Chain & Inventory"];
  const subDomains: SubDomain[] = [
    { id: id(), domainId: scInventory.id, name: "Planning", order: 1 },
    { id: id(), domainId: scInventory.id, name: "Transport", order: 2 },
  ];
  const transport = subDomains[1];

  // ── Sample DataProducts (the two Shepherd products from the registry mockup) ──
  // Product 1: on-track — BRD signed, FSD drafting (stage FSD).
  const p1: DataProduct = {
    id: id(),
    code: "DAPP-6036",
    subDomainId: transport.id,
    name: "Shepherd — Inbound Transport Plan",
    oneLiner: "A daily view of inbound transport plans so planners can pre-empt late deliveries.",
    stage: LifecycleStage.FSD,
    ownerId: po.id,
    createdAt: iso,
    updatedAt: iso,
    createdById: users[2].id, // BA registered
  };
  // Product 2: blocked at the BRD gate (stage BRD, BRD in rigour with a red).
  const p2: DataProduct = {
    id: id(),
    code: "DAPP-6007",
    subDomainId: transport.id,
    name: "Shepherd — Outbound Transport Plan",
    oneLiner: "We need outbound transport plans visible for planning.",
    stage: LifecycleStage.BRD,
    ownerId: po.id,
    createdAt: iso,
    updatedAt: iso,
    createdById: users[2].id,
  };
  const dataProducts: DataProduct[] = [p1, p2];

  // Documents: left with EMPTY content.{} by design — section schemas belong to
  // content (docs/templates/*) and are populated by the AI co-author / UI in a later
  // wave. The seed sets stage/status consistent with the mockups; rigour runs on
  // demand. This keeps the builder from inventing document schemas.
  const documents = [
    { id: id(), dataProductId: p1.id, type: DocType.BRD, status: DocStatus.SIGNED, content: {}, checklistVersion: "brd-v1", createdAt: iso, updatedAt: iso },
    { id: id(), dataProductId: p1.id, type: DocType.FSD, status: DocStatus.DRAFT, content: {}, checklistVersion: "fsd-v1", createdAt: iso, updatedAt: iso },
    { id: id(), dataProductId: p2.id, type: DocType.BRD, status: DocStatus.DRAFT, content: {}, checklistVersion: "brd-v1", createdAt: iso, updatedAt: iso },
  ];

  return {
    schemaVersion: 2,
    streams,
    domains,
    subDomains,
    dataProducts,
    documents,
    glossaryTerms: [],
    rigourChecks: [],
    signatures: [],
    users,
    members: [],
  };
}

export const SEED_STORAGE_KEY = "duidelik.store.v1";
