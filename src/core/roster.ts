// daup-duidelik — per-place role roster (DAUP-PORT-PLAN §5 / O1 RESOLVED)
//
// The house session carries person × place only — NO role (seed `tokens.ts`:
// a `role` claim is never read). duidelik owns authorization in its own store:
//
//   1. First person to redeem into a place BOOTSTRAPS as PRODUCT_OWNER.
//   2. The roster is `members: { peerId|phone → duidelikRole }`, one per place,
//      living in the placeId-scoped store blob (shared per place, O2).
//   3. The sign gate reads the acting person's role from THIS roster, never the
//      session. An unknown person fails safe to the lowest privilege: they can view
//      and draft, but resolveRole returns null → the BRD sign gate rejects (ERR_ROLE)
//      and the FSD gate (any-role) also requires a known member.
//
// Pure functions over the roster array; the store calls them and persists the result.

import { Role } from "./enums";
import type { RoleValue } from "./enums";
import type { PlaceMember } from "../types";

export interface SessionIdentity {
  peerId: string | null;
  phone: string | null;
}

/** Stable roster key for a person: peerId preferred, else phone. Null if neither. */
export function memberKey(id: SessionIdentity): string | null {
  if (id.peerId && id.peerId.trim()) return "peer:" + id.peerId.trim();
  if (id.phone && id.phone.trim()) return "phone:" + id.phone.trim();
  return null;
}

/** Best-effort display name from a session (no name claim exists). Masked phone / short peer. */
export function defaultMemberName(id: SessionIdentity): string {
  if (id.phone && id.phone.trim()) {
    const p = id.phone.trim();
    return p.length > 4 ? "…" + p.slice(-4) : p;
  }
  if (id.peerId && id.peerId.trim()) {
    const peer = id.peerId.trim();
    return "peer-" + peer.slice(0, 6);
  }
  return "unknown";
}

/** Find a member by session identity. Returns null if not a member of this place. */
export function findMember(members: PlaceMember[], id: SessionIdentity): PlaceMember | null {
  const key = memberKey(id);
  if (!key) return null;
  return members.find((m) => m.key === key) || null;
}

/**
 * The acting person's duidelik role, or null if they are not a roster member.
 * null = lowest privilege (view/draft; cannot sign). The sign gate interprets null
 * as "no signer role" → ERR_ROLE.
 */
export function resolveRole(members: PlaceMember[], id: SessionIdentity): RoleValue | null {
  return findMember(members, id)?.role ?? null;
}

/**
 * Ensure the redeeming person is on the roster. If the roster is EMPTY, bootstrap them
 * as PRODUCT_OWNER (first-redeemer rule). If they already exist, return the roster
 * unchanged. Otherwise add them with the lowest privilege (FUNCTIONAL_ANALYST is the
 * least-privileged *known* role; a PO promotes later) — they can view/draft but a BRD
 * sign still needs a PO. Returns the (possibly) updated roster + the member.
 */
export function ensureMember(
  members: PlaceMember[],
  id: SessionIdentity,
  now: Date = new Date(),
): { members: PlaceMember[]; member: PlaceMember } {
  const existing = findMember(members, id);
  if (existing) return { members, member: existing };

  const key = memberKey(id);
  if (!key) throw new Error("Cannot add a member with neither peerId nor phone.");

  const iso = now.toISOString();
  const isFirst = members.length === 0;
  const member: PlaceMember = {
    key,
    peerId: id.peerId ?? null,
    phone: id.phone ?? null,
    role: isFirst ? Role.PRODUCT_OWNER : Role.FUNCTIONAL_ANALYST,
    name: defaultMemberName(id),
    bootstrap: isFirst,
    createdAt: iso,
    updatedAt: iso,
  };
  return { members: [...members, member], member };
}

/**
 * Assign a role to a member (a PO action). Returns the updated roster. Throws if the
 * target is not a member or the actor is not a PRODUCT_OWNER. The actor check is the
 * caller's responsibility too (store enforces), but we guard here so the pure function
 * cannot be misused.
 */
export function assignRole(
  members: PlaceMember[],
  actor: SessionIdentity,
  targetKey: string,
  role: RoleValue,
  now: Date = new Date(),
): PlaceMember[] {
  const actorMember = findMember(members, actor);
  if (!actorMember || actorMember.role !== Role.PRODUCT_OWNER) {
    throw new Error("Only a Product Owner can assign roles.");
  }
  const idx = members.findIndex((m) => m.key === targetKey);
  if (idx === -1) throw new Error("Target is not a member of this place.");
  const copy = members.slice();
  copy[idx] = { ...copy[idx], role, updatedAt: now.toISOString() };
  return copy;
}

/** Rename a member (a PO action; display only). */
export function renameMember(
  members: PlaceMember[],
  actor: SessionIdentity,
  targetKey: string,
  name: string,
  now: Date = new Date(),
): PlaceMember[] {
  const actorMember = findMember(members, actor);
  if (!actorMember || actorMember.role !== Role.PRODUCT_OWNER) {
    throw new Error("Only a Product Owner can rename members.");
  }
  const idx = members.findIndex((m) => m.key === targetKey);
  if (idx === -1) throw new Error("Target is not a member of this place.");
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Name must be non-empty.");
  const copy = members.slice();
  copy[idx] = { ...copy[idx], name: trimmed, updatedAt: now.toISOString() };
  return copy;
}
