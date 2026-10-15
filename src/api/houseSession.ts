// daup-duidelik — house-session receiving client (DAUP-PORT-PLAN §4)
//
// Duidelik does NOT run the OTP door — the Hub does. This module only RECEIVES a
// session: it POSTs a single-use `houseRedeem` to the seed's /house/session/redeem
// and reads back the identity + a short-lived derived bearer. It is the RECEIVING
// side only — it never mints a session and never holds HOUSE_SESSION_SECRET.
//
// Grounded on the seed source read 2026-10-14 (daup-mcp-servers):
//   - src/http/houseSessionHttp.ts `handleRedeem` → the exact response shape.
//   - src/house/tokens.ts → claims carry NO role; `token`/`role`/`pepper` are rejected.
// The canonical client in daup-mcp-servers/client/house-session is READ-ONLY
// reference (BUILDER-KICKOFF §Reference) and is NOT imported or copied — this is a
// focused reimplementation of the redeem contract duidelik needs.
//
// Contract (DAUP-PORT-PLAN §4):
//   - Read the bearer from placeSession | session | daup_house_session | derivedToken.
//     NEVER from `token` — the seed rejects a `token` key as client-invented, and so
//     do we (a payload carrying `token`/`pepper`/`role*` is treated as tainted).
//   - Fail CLOSED: any non-200, missing identity, or network error → not signed in.

const HOUSE_REDEEM_RE = /^[A-Za-z0-9_-]{20,128}$/;
const SID_RE = /^[A-Za-z0-9_-]{16,200}$/;
const PLACE_OR_PEER_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9._-]{16,4000}$/;

// Keys that must never appear on a session payload we accept (role is an app concern
// duidelik owns in its own roster — never read from the session; §5 / O1).
const FORBIDDEN_KEYS = new Set([
  "token",
  "pepper",
  "role",
  "roles",
  "owner",
  "staff",
  "isowner",
  "isstaff",
  "placerole",
  "idlerole",
  "memberrole",
]);

// The seed's mint aliases, in preference order. `token` is deliberately absent.
const BEARER_ALIASES = ["placeSession", "session", "daup_house_session", "derivedToken"] as const;

export interface RedeemedSession {
  ok: true;
  sid: string;
  placeId: string;
  peerId: string | null;
  phone: string | null;
  bearer: string;
  expiresAt: number | null;
}

export interface RedeemFailure {
  ok: false;
  error: string;
  status?: number;
}

export type RedeemResult = RedeemedSession | RedeemFailure;

export type FetchLike = typeof fetch;

/** Normalise a seed origin to scheme://host (no path/query/credentials). */
export function normalizeSeedOrigin(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.origin;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True if the payload carries any client-invented or role-bearing key. */
function tainted(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => FORBIDDEN_KEYS.has(k.toLowerCase()));
}

/** Pick the bearer from the mint aliases (never `token`). */
function readBearer(body: Record<string, unknown>): string | undefined {
  for (const alias of BEARER_ALIASES) {
    const v = body[alias];
    if (typeof v === "string" && OPAQUE_TOKEN_RE.test(v)) return v;
  }
  return undefined;
}

/**
 * Redeem a single-use houseRedeem against the seed. Returns the identity + bearer, or
 * a failure. Fails CLOSED on every error path (DAUP-PORT-PLAN §4 step 4).
 */
export async function redeemHouseSession(input: {
  seedOrigin: string;
  houseRedeem: string;
  fetchImpl?: FetchLike;
}): Promise<RedeemResult> {
  const origin = normalizeSeedOrigin(input.seedOrigin);
  if (!origin) return { ok: false, error: "seed origin is invalid" };
  if (typeof input.houseRedeem !== "string" || !HOUSE_REDEEM_RE.test(input.houseRedeem)) {
    return { ok: false, error: "houseRedeem is required" };
  }

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${origin}/house/session/redeem`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ houseRedeem: input.houseRedeem }),
      cache: "no-store",
      // host-only cookie the seed sets lives on the seed origin; include it
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "seed request failed" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "seed response was not JSON", status: res.status };
  }
  if (!isRecord(body)) return { ok: false, error: "seed response was not JSON", status: res.status };
  if (tainted(body)) return { ok: false, error: "session payload is tainted (role/invented credential)", status: res.status };
  if (res.status !== 200 || body.ok !== true) {
    const msg = typeof body.error === "string" && body.error.trim() ? body.error.trim() : `redeem failed (${res.status})`;
    return { ok: false, error: msg, status: res.status };
  }

  // identity
  const sid = typeof body.sid === "string" ? body.sid.trim() : "";
  const placeId = typeof body.placeId === "string" ? body.placeId.trim() : "";
  if (!SID_RE.test(sid)) return { ok: false, error: "sid is invalid", status: res.status };
  if (!PLACE_OR_PEER_RE.test(placeId)) return { ok: false, error: "placeId is invalid", status: res.status };

  let peerId: string | null = null;
  if (body.peerId != null && body.peerId !== "") {
    if (typeof body.peerId !== "string" || !PLACE_OR_PEER_RE.test(body.peerId.trim())) {
      return { ok: false, error: "peerId is invalid", status: res.status };
    }
    peerId = body.peerId.trim();
  }
  let phone: string | null = null;
  if (body.phone != null && body.phone !== "") {
    if (typeof body.phone !== "string" || !PHONE_RE.test(body.phone.trim())) {
      return { ok: false, error: "phone is invalid", status: res.status };
    }
    phone = body.phone.trim();
  }
  if (!peerId && !phone) return { ok: false, error: "peerId or phone is required", status: res.status };

  const bearer = readBearer(body);
  if (!bearer) return { ok: false, error: "no bearer in redeem response", status: res.status };

  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : null;

  return { ok: true, sid, placeId, peerId, phone, bearer, expiresAt };
}
