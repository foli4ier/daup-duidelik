// daup-duidelik — StoreContext (DAUP-PORT-PLAN §1 context/)
//
// Exposes the duidelik store to the component tree and a hook that subscribes a
// component to its commits via useSyncExternalStore — every committed mutation
// re-renders the UI. The UI reads through the store's selectors and mutates ONLY via
// store.dispatch — it never writes stage/status directly (STACK §2).

import { createContext, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Store } from "../core/store";
import type { StoreGraph } from "../types";

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ store, children }: { store: Store; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used within a StoreProvider");
  return store;
}

/** Subscribe to the store's state; re-renders on every commit. */
export function useStoreState(store: Store): StoreGraph {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState(),
  );
}
