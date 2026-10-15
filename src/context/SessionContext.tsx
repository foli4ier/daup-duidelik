// daup-duidelik — SessionContext (DAUP-PORT-PLAN §4-§5)
//
// The identity seam. Under the daup house session the app is populated from the
// redeemed session ({ placeId, peerId, phone } + a short-lived bearer); the acting
// ROLE comes from duidelik's own per-place roster (core/roster.ts), NOT the session
// (O1). In the standalone fallback (no houseRedeem, or seed unreachable) mode is
// "standalone" and identity is the seeded "acting as" picker (DAUP-PORT-PLAN §4).
//
// This context carries only person × place + the bearer/expiry + which seed origin the
// session came from (so on-prem's runtime seed origin rides along, O3). It never holds
// HOUSE_SESSION_SECRET and never a role.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface HouseSession {
  mode: "house";
  placeId: string;
  peerId: string | null;
  phone: string | null;
  bearer: string;
  expiresAt: number | null;
  seedOrigin: string;
}

export interface StandaloneSession {
  mode: "standalone";
  placeId: null;
  peerId: null;
  phone: null;
}

export type SessionInfo = HouseSession | StandaloneSession;

export const STANDALONE_SESSION: StandaloneSession = {
  mode: "standalone",
  placeId: null,
  peerId: null,
  phone: null,
};

const SessionContext = createContext<SessionInfo>(STANDALONE_SESSION);

export function SessionProvider({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo {
  return useContext(SessionContext);
}
