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
import { DocType, DocStatus, LifecycleStage } from "./enums";
import type { ScoreValue } from "./enums";
import * as lc from "./lifecycle";
import { signAndMaybeUnlock } from "./lifecycle";
import { runRigour, applyOverride } from "./rigour";
import { defaultHash } from "./signing";
import { keysFor } from "./checklists";
import { ensureMember, resolveRole, assignRole, renameMember, memberKey } from "./roster";
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
} from "../types";
import type { RoleValue } from "./enums";

const SCHEMA_VERSION = 2;

// ── intents (the only mutation surface) ────────────────────────────────────────
export type Intent =
  | { type: "SET_ACTING_USER"; userId: string }
  | { type: "REGISTER_PRODUCT"; code: string; subDomainId: string; name: string; oneLiner: string; ownerId?: string | null }
  | { type: "CREATE_SUBDOMAIN"; domainId: string; name: string }
  | { type: "CREATE_BRD"; productId: string }
  | { type: "CREATE_FSD"; productId: string }
  | { type: "CREATE_QRG"; productId: string }
  | { type: "START_RIGOUR"; documentId: string }
  | { type: "RUN_RIGOUR"; documentId: string }
  | { type: "EDIT_DOCUMENT"; documentId: string; content?: DocContent }
  | { type: "APPLY_OVERRIDE"; checkId: string; note: string }
  | { type: "SIGN"; documentId: string }
  | { type: "PUBLISH_QRG"; productId: string }
  | { type: "ADD_GLOSSARY_TERM"; productId: string; term: string; definition: string }
  // ── P3 house-session roster intents ──
  | { type: "ASSIGN_ROLE"; targetKey: string; role: RoleValue }
  | { type: "RENAME_MEMBER"; targetKey: string; name: string };

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
  product: (pid: string) => DataProduct | null;
  docsForProduct: (pid: string) => DuidelikDocument[];
  docOf: (pid: string, type: string) => DuidelikDocument | null;
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
    const seed = buildSeed(genId, clock());
    adapter.write(seed);
    return seed;
  }

  function migrate(s: StoreGraph): StoreGraph {
    let next = s;
    // v1 → v2: add the per-place role roster (empty; populated as people redeem).
    if (next.schemaVersion < 2) {
      next = { ...next, members: next.members ?? [], schemaVersion: 2 };
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

  const resolveUser = (uid: string) => state.users.find((u) => u.id === uid) || null;
  const docsForProduct = (pid: string) => state.documents.filter((d) => d.dataProductId === pid);
  const docOf = (pid: string, type: string) => docsForProduct(pid).find((d) => d.type === type) || null;
  const product = (pid: string) => state.dataProducts.find((p) => p.id === pid) || null;
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

      case "CREATE_SUBDOMAIN": {
        const sd = { id: genId(), domainId: intent.domainId, name: intent.name, order: 99 };
        commit({ ...state, subDomains: [...state.subDomains, sd] });
        return { ok: true, subDomain: sd };
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

  // ── doc helpers ──
  function findDoc(did: string): DuidelikDocument {
    const d = state.documents.find((x) => x.id === did);
    if (!d) throw new lc.TransitionError("Document not found.", "NOT_FOUND");
    return d;
  }
  function putDoc(doc: DuidelikDocument): void {
    commit(withDoc(state, doc));
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
    const seed = buildSeed(genId, clock());
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
    product,
    docsForProduct,
    docOf,
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
