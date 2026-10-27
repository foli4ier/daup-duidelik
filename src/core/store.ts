// duidelik — store (STACK.md §3): in-memory object graph + localStorage persistence
//
// ONE serialized object graph, loaded on boot, written on every committed mutation
// (debounced). Zero-dependency, synchronous, survives reload. schemaVersion enables
// forward-migrations. Export/Import JSON is first-class (STACK §3, the v1 answer to
// "share state" and the bridge to the hosted DB in §5).
//
// The store is the ONLY thing the UI talks to. It never lets the UI write
// stage/status directly: every mutation goes through dispatch(intent), which routes
// to the transition/sign functions in lifecycle.ts / signing.ts / rigour.ts. This is
// the seam that localises the future DB swap (STACK §5): replace the persistence
// adapter (api/persistence.ts); the graph shape and the transition fns are unchanged.
//
// Ported (logic) from app/src/store.js. JS→TS typing + the persistence split
// (DAUP-PORT-PLAN §3): the adapter now comes from api/persistence.ts.

import { ulid } from "./ids";
import { buildSeed } from "./seed";
import { DocType, DocStatus, LifecycleStage, Role } from "./enums";
import type { ScoreValue, DocTypeValue } from "./enums";
import * as lc from "./lifecycle";
import { signAndMaybeUnlock } from "./lifecycle";
import { runRigour, applyOverride } from "./rigour";
import { defaultHash } from "./signing";
import { keysFor } from "./checklists";
import { ensureMember, resolveRole, assignRole, renameMember, onboardMember, memberKey } from "./roster";
import type { SessionIdentity } from "./roster";
import { localStorageAdapter, memoryAdapter } from "../api/persistence";
import type { PersistenceAdapter } from "../api/persistence";
import type { AiClient } from "./aiClient";
import type {
  StoreGraph,
  DataProduct,
  DuidelikDocument,
  RigourCheck,
  Signature,
  User,
  GlossaryTerm,
  DocContent,
  ActingUser,
  PlaceMember,
  RoadmapItem,
  RoadmapColumn,
  ProjectCharter,
} from "../types";
import type { RoleValue } from "./enums";

const SCHEMA_VERSION = 4;

// Normalize an incoming charter: trim every text field, drop blank list entries, and
// collapse a fully-empty charter to null (so a tile with no real charter stores null,
// not a bag of empty strings). Pure — no I/O. Returns null for null/undefined input.
function normalizeCharter(c: ProjectCharter | null | undefined): ProjectCharter | null {
  if (!c) return null;
  const clean: ProjectCharter = {
    purpose: (c.purpose ?? "").trim(),
    scope: (c.scope ?? "").trim(),
    objectives: (c.objectives ?? "").trim(),
    sponsor: (c.sponsor ?? "").trim(),
    stakeholders: (c.stakeholders ?? []).map((s) => s.trim()).filter(Boolean),
    risks: (c.risks ?? "").trim(),
    milestones: (c.milestones ?? []).map((s) => s.trim()).filter(Boolean),
  };
  const hasContent =
    clean.purpose ||
    clean.scope ||
    clean.objectives ||
    clean.sponsor ||
    clean.risks ||
    clean.stakeholders.length > 0 ||
    clean.milestones.length > 0;
  return hasContent ? clean : null;
}

// ── intents (the only mutation surface) ────────────────────────────────────────
export type Intent =
  | { type: "SET_ACTING_USER"; userId: string }
  | { type: "REGISTER_PRODUCT"; code: string; subDomainId: string; name: string; oneLiner: string; ownerId?: string | null }
  | { type: "EDIT_ONELINER"; productId: string; oneLiner: string }
  | { type: "CREATE_SUBDOMAIN"; domainId: string; name: string }
  // ── registry admin (PO-only): archive products, rename tree nodes ──
  | { type: "ARCHIVE_PRODUCT"; productId: string }
  | { type: "UNARCHIVE_PRODUCT"; productId: string }
  | { type: "RENAME_STREAM"; streamId: string; name: string }
  | { type: "RENAME_DOMAIN"; domainId: string; name: string }
  | { type: "RENAME_SUBDOMAIN"; subDomainId: string; name: string }
  | { type: "CREATE_BRD"; productId: string }
  | { type: "CREATE_FSD"; productId: string }
  | { type: "CREATE_QRG"; productId: string }
  | { type: "START_RIGOUR"; documentId: string }
  | { type: "RUN_RIGOUR"; documentId: string }
  | { type: "EDIT_DOCUMENT"; documentId: string; content?: DocContent }
  | { type: "APPLY_OVERRIDE"; checkId: string; note: string }
  | { type: "SIGN"; documentId: string }
  // ── owner unlock: re-open a SIGNED document for editing (PO-gated). Routes through
  //    the SAME invalidation path as an edit (LIFECYCLE §5): the old signature stays
  //    on record as historical; the doc drops to DRAFT; downstream is pulled back. ──
  | { type: "UNLOCK_DOCUMENT"; documentId: string }
  | { type: "PUBLISH_QRG"; productId: string }
  | { type: "ADD_GLOSSARY_TERM"; productId: string; term: string; definition: string }
  // ── per-artifact import (file round-trip; see core/artifact.ts). A document import
  //    always applies via EDIT_DOCUMENT so a signed doc re-opens to DRAFT (no forged
  //    signature). Glossary import merges terms by case-insensitive term name. ──
  | { type: "IMPORT_DOCUMENT"; productId: string; docType: DocTypeValue; content: DocContent }
  | { type: "IMPORT_GLOSSARY"; productId: string; terms: Array<{ term: string; definition: string }> }
  // ── per-product roadmap kanban (tiles = projects; CURRENT|PLANNED|FUTURE columns).
  //    Ungated authoring (like the glossary); links to a registry product or a deferred
  //    daup-projects ref. No lifecycle/gate interaction — a roadmap tile never touches
  //    document status, rigour or signatures. ──
  | { type: "ADD_ROADMAP_ITEM"; productId: string; column: RoadmapColumn; title: string; note?: string; linkedProductId?: string | null; daupProjectRef?: string | null; charter?: ProjectCharter | null }
  | { type: "EDIT_ROADMAP_ITEM"; itemId: string; title?: string; note?: string; linkedProductId?: string | null; daupProjectRef?: string | null; charter?: ProjectCharter | null }
  | { type: "MOVE_ROADMAP_ITEM"; itemId: string; column: RoadmapColumn }
  | { type: "REMOVE_ROADMAP_ITEM"; itemId: string }
  // ── P3 house-session roster intents ──
  | { type: "ASSIGN_ROLE"; targetKey: string; role: RoleValue }
  | { type: "RENAME_MEMBER"; targetKey: string; name: string }
  | { type: "ONBOARD_MEMBER"; name: string; role: RoleValue };

export type DispatchResult = { ok: boolean; code?: string; message?: string } & Record<string, unknown>;

export interface CreateStoreOpts {
  adapter?: PersistenceAdapter;
  aiClient?: AiClient | null;
  genId?: () => string;
  clock?: () => Date;
  placeId?: string | null;
  // P3: when a redeemed house session is present, the store runs in "house" identity
  // mode — the acting user is derived from this session + the per-place roster, NOT the
  // seeded users picker. Absent → standalone mode (the v1 "acting as" picker).
  session?: SessionIdentity | null;
}

export interface Store {
  getState: () => StoreGraph;
  subscribe: (fn: (s: StoreGraph) => void) => () => void;
  dispatch: (intent: Intent) => DispatchResult | Promise<DispatchResult>;
  actingUser: () => User | null;
  resolveUser: (uid: string) => User | null;
  ownerCandidates: () => User[];
  product: (pid: string) => DataProduct | null;
  activeProducts: () => DataProduct[];
  archivedProducts: () => DataProduct[];
  isPO: () => boolean;
  docsForProduct: (pid: string) => DuidelikDocument[];
  docOf: (pid: string, type: string) => DuidelikDocument | null;
  glossaryForProduct: (pid: string) => GlossaryTerm[];
  roadmapForProduct: (pid: string) => RoadmapItem[];
  signatureForDoc: (did: string) => Signature | null;
  checksForDoc: (did: string) => RigourCheck[];
  placementIntact: (p: DataProduct) => boolean;
  signedBrdKeys: (p: DataProduct) => string[];
  exportJson: () => string;
  importJson: (json: string | StoreGraph) => { ok: true };
  reset: () => { ok: true };
  checklistKeysFor: (docType: string) => string[];
  // P3: identity mode + roster
  isHouseMode: () => boolean;
  members: () => PlaceMember[];
  actingMember: () => PlaceMember | null;
  SCHEMA_VERSION: number;
}

export function createStore(opts: CreateStoreOpts = {}): Store {
  const genId = opts.genId || ulid;
  const clock = opts.clock || (() => new Date());
  const adapter: PersistenceAdapter =
    opts.adapter ||
    (typeof globalThis !== "undefined" && globalThis.localStorage
      ? localStorageAdapter(opts.placeId ?? null)
      : memoryAdapter());
  const aiClient = opts.aiClient || null;
  const session: SessionIdentity | null = opts.session ?? null;
  const houseMode = session != null;

  let state: StoreGraph = hydrate();
  // Standalone-mode acting user (the seeded picker). Ignored in house mode.
  let actingUserId: string | null = state.users[0]?.id ?? null;
  const listeners = new Set<(s: StoreGraph) => void>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // In house mode, ensure the redeeming person is on the per-place roster (bootstrap
  // the first redeemer as PRODUCT_OWNER). This is the only place a redeem writes a role.
  if (houseMode && session) {
    const { members: nextMembers } = ensureMember(state.members ?? [], session, clock());
    if (nextMembers !== (state.members ?? [])) {
      state = { ...state, members: nextMembers };
      adapter.write(state);
    }
  }

  function hydrate(): StoreGraph {
    const persisted = safe(() => adapter.read());
    if (persisted && persisted.schemaVersion != null) {
      return migrate(persisted);
    }
    // A fresh HOUSE place seeds the enterprise tree only (no demo users/products);
    // standalone/preview seeds the sample population. houseMode is known here.
    const seed = buildSeed(genId, clock(), !houseMode);
    adapter.write(seed);
    return seed;
  }

  function migrate(s: StoreGraph): StoreGraph {
    let next = s;
    // v1 → v2: add the per-place role roster (empty; populated as people redeem).
    if (next.schemaVersion < 2) {
      next = { ...next, members: next.members ?? [], schemaVersion: 2 };
    }
    // v2 → v3: products gain an optional archivedAt. No backfill needed — an absent
    // field reads as active. Bump the version so the shape is recorded.
    if (next.schemaVersion < 3) {
      next = { ...next, schemaVersion: 3 };
    }
    // v3 → v4: add the per-product roadmap tiles. Backfill [] so the Roadmap tab reads
    // an array on an older blob instead of undefined.
    if (next.schemaVersion < 4) {
      next = { ...next, roadmapItems: next.roadmapItems ?? [], schemaVersion: 4 };
    }
    if (next.schemaVersion !== SCHEMA_VERSION) {
      next = { ...next, schemaVersion: SCHEMA_VERSION };
    }
    return next;
  }

  function save(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => adapter.write(state), 150); // debounced
  }

  function commit(next: StoreGraph): void {
    state = next;
    save();
    for (const fn of listeners) fn(state);
  }

  function subscribe(fn: (s: StoreGraph) => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  // ── selectors ──
  const getState = () => state;

  const members = (): PlaceMember[] => state.members ?? [];
  const actingMember = (): PlaceMember | null => {
    if (!houseMode || !session) return null;
    const key = memberKey(session);
    if (!key) return null;
    return members().find((m) => m.key === key) || null;
  };

  // actingUser() returns a User-shaped object for the UI. In house mode it is synthesised
  // from the roster member (id = roster key, role from the roster). In standalone mode it
  // is the seeded picker user. Null in house mode when the person is not (yet) a member.
  const actingUser = (): User | null => {
    if (houseMode) {
      const m = actingMember();
      if (!m) return null;
      return { id: m.key, name: m.name, role: m.role };
    }
    return state.users.find((u) => u.id === actingUserId) || null;
  };

  // The identity the sign gate reads (ActingUser = { id, role }). In house mode the role
  // comes from the roster (null → not a signer; the gate returns ERR_ROLE). In standalone
  // mode it is the picked user's role.
  const signingActor = (): ActingUser | null => {
    if (houseMode) {
      if (!session) return null;
      const role = resolveRole(members(), session);
      if (role == null) return null; // unknown person → no signer role (fail safe)
      const key = memberKey(session);
      return key ? { id: key, role } : null;
    }
    const u = state.users.find((x) => x.id === actingUserId);
    return u ? { id: u.id, role: u.role } : null;
  };

  const isHouseMode = () => houseMode;

  // The population the BRD owner-picker should choose from (one accountable PO per
  // product, DATA-MODEL §3 / brd.single_owner). In HOUSE mode this is the per-place
  // ROSTER (members[] whose role is PRODUCT_OWNER), mapped to User shape with the
  // member's stable key as id — so a PO added in the roster appears here, and the id
  // stored on DataProduct.ownerId matches currentPersonId()'s keying. In standalone
  // mode it is the seeded users picker. This is the fix for "a roster PO is missing
  // from the owner dropdown": the picker must read the roster, not the demo users.
  const ownerCandidates = (): User[] => {
    if (houseMode) {
      return members()
        .filter((m) => m.role === Role.PRODUCT_OWNER)
        .map((m) => ({ id: m.key, name: m.name, role: m.role }));
    }
    return state.users.filter((u) => u.role === Role.PRODUCT_OWNER);
  };

  // Resolve an id to a displayable User. Checks the seeded users first, then the roster
  // (a house-mode owner id is a roster member key, not a seeded user id) so an ownerId
  // set from the roster still resolves to a name in the UI and in print.
  const resolveUser = (uid: string): User | null => {
    const u = state.users.find((x) => x.id === uid);
    if (u) return u;
    const m = members().find((x) => x.key === uid);
    return m ? { id: m.key, name: m.name, role: m.role } : null;
  };
  const docsForProduct = (pid: string) => state.documents.filter((d) => d.dataProductId === pid);
  const docOf = (pid: string, type: string) => docsForProduct(pid).find((d) => d.type === type) || null;
  const glossaryForProduct = (pid: string) =>
    state.glossaryTerms.filter((t) => t.dataProductId === pid).sort((a, b) => a.term.localeCompare(b.term));
  const roadmapForProduct = (pid: string) =>
    (state.roadmapItems ?? [])
      .filter((r) => r.dataProductId === pid)
      .sort((a, b) => a.order - b.order);
  const signatureForDoc = (did: string): Signature | null => {
    const sigs = state.signatures.filter((s) => s.documentId === did);
    return sigs.length ? sigs[sigs.length - 1] : null;
  };
  const product = (pid: string) => state.dataProducts.find((p) => p.id === pid) || null;
  const activeProducts = () => state.dataProducts.filter((p) => !p.archivedAt);
  const archivedProducts = () => state.dataProducts.filter((p) => !!p.archivedAt);
  const isPO = () => signingActor()?.role === Role.PRODUCT_OWNER;
  const checksForDoc = (did: string) => state.rigourChecks.filter((c) => c.documentId === did);

  // Is the Stream→Domain→SubDomain chain intact for a product? (brd.domain_placement)
  function placementIntact(p: DataProduct): boolean {
    const sd = state.subDomains.find((s) => s.id === p.subDomainId);
    if (!sd) return false;
    const dom = state.domains.find((d) => d.id === sd.domainId);
    if (!dom) return false;
    return !!state.streams.find((s) => s.id === dom.streamId);
  }

  // signed-BRD content keys, for fsd.traceable_to_brd
  function signedBrdKeys(p: DataProduct): string[] {
    const brd = docOf(p.id, DocType.BRD);
    if (!brd || brd.status !== DocStatus.SIGNED) return [];
    return Object.keys(brd.content || {});
  }

  // ── intent dispatch (the ONLY mutation surface) ──
  // Returns a plain result object for every intent EXCEPT RUN_RIGOUR, which is async
  // (it may await aiClient.score) and returns a Promise. Callers should `await`
  // dispatch(...) uniformly — awaiting a non-Promise is a no-op, so this is safe.
  function dispatch(intent: Intent): DispatchResult | Promise<DispatchResult> {
    const now = clock();
    switch (intent.type) {
      case "SET_ACTING_USER": {
        if (resolveUser(intent.userId)) actingUserId = intent.userId;
        for (const fn of listeners) fn(state);
        return { ok: true, actingUserId };
      }

      case "REGISTER_PRODUCT": {
        const p: DataProduct = {
          id: genId(),
          code: intent.code,
          subDomainId: intent.subDomainId,
          name: intent.name,
          oneLiner: intent.oneLiner,
          stage: LifecycleStage.ONE_LINER,
          ownerId: intent.ownerId ?? null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          createdById: currentPersonId(),
        };
        commit({ ...state, dataProducts: [...state.dataProducts, p] });
        return { ok: true, product: p };
      }

      case "EDIT_ONELINER": {
        // The one-liner is the product's originating request text (DataProduct.oneLiner),
        // NOT BRD content — so editing it is a product-field update and deliberately does
        // NOT touch any document status or trigger the signature-invalidation cascade.
        // Ungated: it is the request statement, editable at any stage (the BRD's own
        // content.oneLiner mirror, if the author set one, is edited separately in the doc).
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        const oneLiner = (intent.oneLiner ?? "").trim();
        if (!oneLiner) return { ok: false, code: "EMPTY", message: "The one-liner cannot be empty." };
        const updated: DataProduct = { ...p, oneLiner, updatedAt: now.toISOString() };
        commit({ ...state, dataProducts: upsert(state.dataProducts, updated) });
        return { ok: true, product: updated };
      }

      case "CREATE_SUBDOMAIN": {
        const sd = { id: genId(), domainId: intent.domainId, name: intent.name, order: 99 };
        commit({ ...state, subDomains: [...state.subDomains, sd] });
        return { ok: true, subDomain: sd };
      }

      case "ARCHIVE_PRODUCT": {
        const gate = requirePO();
        if (gate) return gate;
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        if (p.archivedAt) return { ok: true, product: p }; // idempotent
        const updated: DataProduct = {
          ...p,
          archivedAt: now.toISOString(),
          archivedById: currentPersonId(),
          updatedAt: now.toISOString(),
        };
        commit({ ...state, dataProducts: upsert(state.dataProducts, updated) });
        return { ok: true, product: updated };
      }

      case "UNARCHIVE_PRODUCT": {
        const gate = requirePO();
        if (gate) return gate;
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        if (!p.archivedAt) return { ok: true, product: p }; // idempotent
        const updated: DataProduct = {
          ...p,
          archivedAt: null,
          archivedById: null,
          updatedAt: now.toISOString(),
        };
        commit({ ...state, dataProducts: upsert(state.dataProducts, updated) });
        return { ok: true, product: updated };
      }

      case "RENAME_STREAM": {
        const gate = requirePO();
        if (gate) return gate;
        const name = (intent.name ?? "").trim();
        if (!name) return { ok: false, code: "EMPTY", message: "Name must be non-empty." };
        const s = state.streams.find((x) => x.id === intent.streamId);
        if (!s) return { ok: false, code: "NOT_FOUND", message: "Stream not found." };
        const updated = { ...s, name };
        commit({ ...state, streams: state.streams.map((x) => (x.id === s.id ? updated : x)) });
        return { ok: true, stream: updated };
      }

      case "RENAME_DOMAIN": {
        const gate = requirePO();
        if (gate) return gate;
        const name = (intent.name ?? "").trim();
        if (!name) return { ok: false, code: "EMPTY", message: "Name must be non-empty." };
        const d = state.domains.find((x) => x.id === intent.domainId);
        if (!d) return { ok: false, code: "NOT_FOUND", message: "Domain not found." };
        const updated = { ...d, name };
        commit({ ...state, domains: state.domains.map((x) => (x.id === d.id ? updated : x)) });
        return { ok: true, domain: updated };
      }

      case "RENAME_SUBDOMAIN": {
        const gate = requirePO();
        if (gate) return gate;
        const name = (intent.name ?? "").trim();
        if (!name) return { ok: false, code: "EMPTY", message: "Name must be non-empty." };
        const sd = state.subDomains.find((x) => x.id === intent.subDomainId);
        if (!sd) return { ok: false, code: "NOT_FOUND", message: "Sub-domain not found." };
        const updated = { ...sd, name };
        commit({ ...state, subDomains: state.subDomains.map((x) => (x.id === sd.id ? updated : x)) });
        return { ok: true, subDomain: updated };
      }

      case "CREATE_BRD":
        return apply(() => lc.createBrd(product(intent.productId)!, { genId, now }));
      case "CREATE_FSD": {
        const p = product(intent.productId)!;
        return apply(() => lc.createFsd(p, docOf(p.id, DocType.BRD), { genId, now }));
      }
      case "CREATE_QRG": {
        const p = product(intent.productId)!;
        return apply(() => lc.createQrg(p, docOf(p.id, DocType.FSD), { genId, now }));
      }

      case "START_RIGOUR": {
        const doc = findDoc(intent.documentId);
        try {
          const res = lc.startRigour(doc, { now });
          putDoc(res.document);
          return { ok: true, document: res.document };
        } catch (e) {
          return errResult(e);
        }
      }

      case "RUN_RIGOUR":
        return runRigourIntent(intent, now);

      case "EDIT_DOCUMENT": {
        const doc = findDoc(intent.documentId);
        const p = product(doc.dataProductId)!;
        const next: DuidelikDocument = {
          ...doc,
          content: intent.content != null ? intent.content : doc.content,
        };
        const res = lc.editDocument(next, p, docsForProduct(p.id), { now });
        let nextState = withDoc(state, res.document);
        if (res.invalidation) {
          nextState = {
            ...nextState,
            dataProducts: upsert(nextState.dataProducts, res.invalidation.product),
          };
          for (const d of res.invalidation.documents) nextState = withDoc(nextState, d);
        }
        commit(nextState);
        return { ok: true, document: res.document, invalidation: res.invalidation || null };
      }

      case "APPLY_OVERRIDE": {
        const check = state.rigourChecks.find((c) => c.id === intent.checkId);
        if (!check) return { ok: false, code: "NOT_FOUND", message: "Rigour check not found." };
        const updated = applyOverride(check, intent.note, currentPersonId(), now);
        commit({ ...state, rigourChecks: upsert(state.rigourChecks, updated) });
        return { ok: true, check: updated };
      }

      case "SIGN":
        return signIntent(intent, now);

      case "UNLOCK_DOCUMENT": {
        // Owner-only re-open of a SIGNED document. The engine already supports editing
        // a signed doc (it drops to DRAFT + cascades, LIFECYCLE §5), but that is a side
        // effect of editing; this makes re-opening a DELIBERATE, owner-gated action with
        // no content change. Authorization reads the SAME actor as the sign gate
        // (signingActor → roster in house mode, picker standalone), so "owner" == PO.
        const gate = requirePO();
        if (gate) return gate;
        const doc = findDoc(intent.documentId);
        if (doc.status !== DocStatus.SIGNED) {
          return { ok: false, code: "NOT_SIGNED", message: "Only a signed document can be unlocked." };
        }
        const p = product(doc.dataProductId)!;
        // No content change — editDocument(same content) drops SIGNED → DRAFT and runs
        // invalidateDownstream. The old Signature stays on record (historical); its
        // documentHash no longer matches the live doc, which is the proof it is stale.
        const res = lc.editDocument(doc, p, docsForProduct(p.id), { now });
        let nextState = withDoc(state, res.document);
        if (res.invalidation) {
          nextState = {
            ...nextState,
            dataProducts: upsert(nextState.dataProducts, res.invalidation.product),
          };
          for (const d of res.invalidation.documents) nextState = withDoc(nextState, d);
        }
        commit(nextState);
        return { ok: true, document: res.document, invalidation: res.invalidation || null };
      }

      case "IMPORT_DOCUMENT": {
        // Apply an imported artifact's content to this product's document of that type.
        // Create the doc first if it does not exist yet (respecting the lifecycle gate
        // — e.g. an FSD import still needs a signed BRD to exist). Then route the
        // content through EDIT_DOCUMENT so a signed target re-opens to DRAFT: an import
        // NEVER preserves a signature, so it can never forge a sign-off (RIGOUR §3).
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        let doc = docOf(p.id, intent.docType);
        if (!doc) {
          const created = createDocForImport(p, intent.docType, now);
          if (!created.ok) return created;
          doc = created.document!;
        }
        const edit = dispatch({ type: "EDIT_DOCUMENT", documentId: doc.id, content: intent.content }) as DispatchResult;
        return edit;
      }

      case "IMPORT_GLOSSARY": {
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        const existing = state.glossaryTerms.filter((t) => t.dataProductId === p.id);
        const byLower = new Map(existing.map((t) => [t.term.toLowerCase(), t]));
        let added = 0;
        let updated = 0;
        let nextTerms = state.glossaryTerms.slice();
        for (const row of intent.terms) {
          const term = (row.term ?? "").trim();
          const def = (row.definition ?? "").trim();
          if (!term) continue;
          const hit = byLower.get(term.toLowerCase());
          if (hit) {
            // merge: update the definition in place (idempotent re-import)
            const u: GlossaryTerm = { ...hit, definition: def || hit.definition, updatedAt: now.toISOString() };
            nextTerms = upsert(nextTerms, u);
            updated++;
          } else {
            const gt: GlossaryTerm = {
              id: genId(),
              dataProductId: p.id,
              term,
              definition: def,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            };
            nextTerms = [...nextTerms, gt];
            byLower.set(term.toLowerCase(), gt);
            added++;
          }
        }
        commit({ ...state, glossaryTerms: nextTerms });
        return { ok: true, added, updated };
      }

      case "ADD_ROADMAP_ITEM": {
        const p = product(intent.productId);
        if (!p) return { ok: false, code: "NOT_FOUND", message: "Product not found." };
        const title = (intent.title ?? "").trim();
        if (!title) return { ok: false, code: "EMPTY", message: "A roadmap tile needs a title." };
        const items = state.roadmapItems ?? [];
        // next order = end of the target column
        const inCol = items.filter((r) => r.dataProductId === p.id && r.column === intent.column);
        const order = inCol.reduce((m, r) => Math.max(m, r.order), -1) + 1;
        const item: RoadmapItem = {
          id: genId(),
          dataProductId: p.id,
          column: intent.column,
          title,
          note: (intent.note ?? "").trim(),
          linkedProductId: intent.linkedProductId ?? null,
          daupProjectRef: intent.daupProjectRef ?? null,
          charter: normalizeCharter(intent.charter),
          order,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        commit({ ...state, roadmapItems: [...items, item] });
        return { ok: true, item };
      }

      case "EDIT_ROADMAP_ITEM": {
        const items = state.roadmapItems ?? [];
        const it = items.find((r) => r.id === intent.itemId);
        if (!it) return { ok: false, code: "NOT_FOUND", message: "Roadmap tile not found." };
        const title = intent.title != null ? intent.title.trim() : it.title;
        if (!title) return { ok: false, code: "EMPTY", message: "A roadmap tile needs a title." };
        const updated: RoadmapItem = {
          ...it,
          title,
          note: intent.note != null ? intent.note.trim() : it.note,
          linkedProductId: intent.linkedProductId !== undefined ? intent.linkedProductId : it.linkedProductId,
          daupProjectRef: intent.daupProjectRef !== undefined ? intent.daupProjectRef : it.daupProjectRef,
          charter: intent.charter !== undefined ? normalizeCharter(intent.charter) : (it.charter ?? null),
          updatedAt: now.toISOString(),
        };
        commit({ ...state, roadmapItems: upsert(items, updated) });
        return { ok: true, item: updated };
      }

      case "MOVE_ROADMAP_ITEM": {
        const items = state.roadmapItems ?? [];
        const it = items.find((r) => r.id === intent.itemId);
        if (!it) return { ok: false, code: "NOT_FOUND", message: "Roadmap tile not found." };
        if (it.column === intent.column) return { ok: true, item: it }; // no-op
        const inCol = items.filter((r) => r.dataProductId === it.dataProductId && r.column === intent.column);
        const order = inCol.reduce((m, r) => Math.max(m, r.order), -1) + 1;
        const updated: RoadmapItem = { ...it, column: intent.column, order, updatedAt: now.toISOString() };
        commit({ ...state, roadmapItems: upsert(items, updated) });
        return { ok: true, item: updated };
      }

      case "REMOVE_ROADMAP_ITEM": {
        const items = state.roadmapItems ?? [];
        if (!items.some((r) => r.id === intent.itemId)) {
          return { ok: false, code: "NOT_FOUND", message: "Roadmap tile not found." };
        }
        commit({ ...state, roadmapItems: items.filter((r) => r.id !== intent.itemId) });
        return { ok: true };
      }

      case "PUBLISH_QRG": {
        const p = product(intent.productId)!;
        return apply(() => lc.publishQrg(p, docOf(p.id, DocType.QRG), { now }));
      }

      case "ADD_GLOSSARY_TERM": {
        const term = (intent.term ?? "").trim();
        const def = (intent.definition ?? "").trim();
        if (!term || !def) return { ok: false, code: "EMPTY", message: "Term and definition are required." };
        const dup = state.glossaryTerms.some(
          (t) => t.dataProductId === intent.productId && t.term.toLowerCase() === term.toLowerCase(),
        );
        const gt: GlossaryTerm = {
          id: genId(),
          dataProductId: intent.productId,
          term,
          definition: def,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        commit({ ...state, glossaryTerms: [...state.glossaryTerms, gt] });
        return { ok: true, term: gt, duplicateWarning: dup };
      }

      case "ASSIGN_ROLE": {
        if (!houseMode || !session) {
          return { ok: false, code: "NOT_HOUSE_MODE", message: "Role assignment is only available under a house session." };
        }
        try {
          const next = assignRole(members(), session, intent.targetKey, intent.role, now);
          commit({ ...state, members: next });
          return { ok: true, members: next };
        } catch (e) {
          return { ok: false, code: "ERR_ROLE", message: (e as Error).message };
        }
      }

      case "RENAME_MEMBER": {
        if (!houseMode || !session) {
          return { ok: false, code: "NOT_HOUSE_MODE", message: "Member rename is only available under a house session." };
        }
        try {
          const next = renameMember(members(), session, intent.targetKey, intent.name, now);
          commit({ ...state, members: next });
          return { ok: true, members: next };
        } catch (e) {
          return { ok: false, code: "ERROR", message: (e as Error).message };
        }
      }

      case "ONBOARD_MEMBER": {
        if (!houseMode || !session) {
          return { ok: false, code: "NOT_HOUSE_MODE", message: "Onboarding a member is only available under a house session." };
        }
        try {
          const { members: next, member } = onboardMember(members(), session, intent.name, intent.role, genId, now);
          commit({ ...state, members: next });
          return { ok: true, members: next, member };
        } catch (e) {
          return { ok: false, code: "ERROR", message: (e as Error).message };
        }
      }

      default: {
        // Exhaustiveness: an unknown intent type.
        const unknown = intent as { type?: string };
        return { ok: false, code: "UNKNOWN_INTENT", message: `Unknown intent ${unknown.type}` };
      }
    }
  }

  // run a transition fn that returns {product?, document?} and commit the patch
  function apply(fn: () => { product?: DataProduct; document?: DuidelikDocument }): DispatchResult {
    let res: { product?: DataProduct; document?: DuidelikDocument };
    try {
      res = fn();
    } catch (e) {
      return errResult(e);
    }
    let next = state;
    if (res.product) next = { ...next, dataProducts: upsert(next.dataProducts, res.product) };
    if (res.document) next = withDoc(next, res.document);
    commit(next);
    return { ok: true, ...res };
  }

  async function runRigourIntent(intent: { documentId: string }, now: Date): Promise<DispatchResult> {
    const doc = findDoc(intent.documentId);
    const p = product(doc.dataProductId)!;
    const ctx = {
      content: doc.content || {},
      product: p,
      resolveUser,
      placementIntact: placementIntact(p),
      signedBrdKeys: signedBrdKeys(p),
      now,
    };
    const prior = checksForDoc(doc.id);
    const { checks, rollup, deterministicOnly } = await runRigour(doc, ctx, {
      aiClient,
      priorChecks: prior,
      genId,
    });
    // replace all checks for this doc by key
    const others = state.rigourChecks.filter((c) => c.documentId !== doc.id);
    commit({ ...state, rigourChecks: [...others, ...checks] });
    return { ok: true, checks, rollup: rollup as ScoreValue, deterministicOnly };
  }

  function signIntent(intent: { documentId: string }, now: Date): DispatchResult {
    const doc = findDoc(intent.documentId);
    const checks = checksForDoc(doc.id);
    const actor = signingActor();
    if (!actor) {
      // House mode, person not on the roster → fail safe with the §5 role contract.
      return {
        ok: false,
        code: "ERR_ROLE",
        message: houseMode
          ? "You are not a member of this place's registry, so you cannot sign."
          : "No acting user.",
        items: [],
      };
    }
    const res = signAndMaybeUnlock(doc, checks, actor, { genId, hash: defaultHash, now });
    if (!res.ok) return { ...res }; // {ok:false, code, message, items} — §5 error contract
    const next: StoreGraph = {
      ...state,
      documents: upsert(state.documents, res.document) as DuidelikDocument[],
      signatures: [...state.signatures, res.signature as Signature],
    };
    commit(next);
    return { ok: true, signature: res.signature, document: res.document };
  }

  // The id to stamp as createdById / overriddenById for the current person.
  function currentPersonId(): string | null {
    if (houseMode) return session ? memberKey(session) : null;
    return actingUserId;
  }

  // Registry-admin gate: archiving a product and renaming tree nodes are PRODUCT_OWNER
  // actions. Reads the acting role the SAME way the sign gate does (signingActor →
  // roster in house mode, picker in standalone), so authorization is one source of
  // truth. Returns an ERR_ROLE DispatchResult when the actor is not a PO, else null
  // (meaning "allowed").
  function requirePO(): DispatchResult | null {
    const actor = signingActor();
    if (!actor) {
      return {
        ok: false,
        code: "ERR_ROLE",
        message: houseMode
          ? "You are not a member of this place's registry."
          : "No acting user.",
      };
    }
    if (actor.role !== Role.PRODUCT_OWNER) {
      return { ok: false, code: "ERR_ROLE", message: "Only a Product Owner can change the registry." };
    }
    return null;
  }

  // ── doc helpers ──
  function findDoc(did: string): DuidelikDocument {
    const d = state.documents.find((x) => x.id === did);
    if (!d) throw new lc.TransitionError("Document not found.", "NOT_FOUND");
    return d;
  }
  function putDoc(doc: DuidelikDocument): void {
    commit(withDoc(state, doc));
  }

  // Create a BRD/FSD/QRG for an import when the product has none yet, honouring the
  // lifecycle creation gates (createFsd still requires a SIGNED BRD, etc.). Returns the
  // created document, or a gate error the caller surfaces. Does not touch content —
  // the caller's EDIT_DOCUMENT writes the imported content next.
  function createDocForImport(
    p: DataProduct,
    docType: DocTypeValue,
    now: Date,
  ): DispatchResult & { document?: DuidelikDocument } {
    try {
      let res: { product?: DataProduct; document?: DuidelikDocument };
      if (docType === DocType.BRD) res = lc.createBrd(p, { genId, now });
      else if (docType === DocType.FSD) res = lc.createFsd(p, docOf(p.id, DocType.BRD), { genId, now });
      else res = lc.createQrg(p, docOf(p.id, DocType.FSD), { genId, now });
      let next = state;
      if (res.product) next = { ...next, dataProducts: upsert(next.dataProducts, res.product) };
      if (res.document) next = withDoc(next, res.document);
      commit(next);
      return { ok: true, document: res.document };
    } catch (e) {
      return errResult(e);
    }
  }

  // ── export / import (STACK §3, first-class) ──
  function exportJson(): string {
    return JSON.stringify(state, null, 2);
  }
  function importJson(json: string | StoreGraph): { ok: true } {
    const parsed = typeof json === "string" ? (JSON.parse(json) as StoreGraph) : json;
    if (!parsed || parsed.schemaVersion == null) throw new Error("Not a duidelik registry export.");
    commit(migrate(parsed));
    actingUserId = state.users[0]?.id ?? null;
    return { ok: true };
  }
  function reset(): { ok: true } {
    const seed = buildSeed(genId, clock(), !houseMode);
    commit(seed);
    actingUserId = state.users[0]?.id ?? null;
    return { ok: true };
  }

  return {
    getState,
    subscribe,
    dispatch,
    actingUser,
    resolveUser,
    ownerCandidates,
    product,
    activeProducts,
    archivedProducts,
    isPO,
    docsForProduct,
    docOf,
    glossaryForProduct,
    roadmapForProduct,
    signatureForDoc,
    checksForDoc,
    placementIntact,
    signedBrdKeys,
    exportJson,
    importJson,
    reset,
    checklistKeysFor: (docType: string) => keysFor(docType as any),
    isHouseMode,
    members,
    actingMember,
    SCHEMA_VERSION,
  };
}

// ── pure graph helpers ──
function upsert<T extends { id?: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i === -1) return [...arr, item];
  const copy = arr.slice();
  copy[i] = item;
  return copy;
}
function withDoc(s: StoreGraph, doc: DuidelikDocument): StoreGraph {
  return { ...s, documents: upsert(s.documents, doc) };
}
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
function errResult(e: unknown): DispatchResult {
  const err = e as { code?: string; message?: string };
  return { ok: false, code: err.code || "ERROR", message: err.message || String(e) };
}
