// daup-duidelik — persistence adapter (DAUP-PORT-PLAN §3, STACK §3/§5)
//
// The swappable persistence seam. v1 is a localStorage single JSON blob; a later DB
// swap (STACK §5) replaces ONLY this file. Split out of the store (eatout's
// src/api/store.ts convention) so the store stays pure graph + transition logic.
//
// placeId scoping (DAUP-PORT-PLAN §3, O2 RESOLVED): the store key is
// `duidelik.store.v1.<placeId>` so each daup place/node has its own shared registry.
// Until the house session lands (P3), placeId defaults to "standalone" — the local
// fallback identity (DAUP-PORT-PLAN §4 standalone fallback). The key shape is already
// placeId-scoped so P3 is a one-argument change, not a migration.

import type { StoreGraph } from "../types";

export interface PersistenceAdapter {
  read: () => StoreGraph | null;
  write: (v: StoreGraph) => void;
}

const BASE_KEY = "duidelik.store.v1";

/** Build the placeId-scoped storage key (DAUP-PORT-PLAN §3). */
export function storageKey(placeId: string | null | undefined): string {
  return `${BASE_KEY}.${placeId || "standalone"}`;
}

/**
 * localStorage adapter, scoped by placeId. Falls back to a no-op read/write when no
 * localStorage exists (SSR / vitest node env without jsdom) so the store still builds
 * from seed.
 */
export function localStorageAdapter(placeId: string | null = null): PersistenceAdapter {
  const key = storageKey(placeId);
  const ls = (typeof globalThis !== "undefined" && globalThis.localStorage) || null;
  return {
    read: () => {
      if (!ls) return null;
      const raw = ls.getItem(key);
      return raw ? (JSON.parse(raw) as StoreGraph) : null;
    },
    write: (v: StoreGraph) => {
      if (ls) ls.setItem(key, JSON.stringify(v));
    },
  };
}

/** In-memory adapter — tests and a transient preview with no persistence. */
export function memoryAdapter(initial: StoreGraph | null = null): PersistenceAdapter {
  let blob: StoreGraph | null = initial;
  return {
    read: () => blob,
    write: (v: StoreGraph) => {
      blob = v;
    },
  };
}
