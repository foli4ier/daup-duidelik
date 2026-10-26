// daup-duidelik — Open-in-Project link builder (A-i, scope doc
// docs/SCOPE-roadmap-daup-projects-and-plan.md).
//
// A Roadmap tile may carry a daupProjectRef pointing at the daup `project` app
// (project.daup.co.za, module daup-project). This module turns that ref + the current
// place context into a Hub-style OPEN URL, so clicking "Open in Project ↗" full-
// navigates to Project, which runs its OWN door. duidelik reads/writes NOTHING from
// Project and never mints a credential — it is a pure deep-link out.
//
// Handshake contract (mirrored from daup-frontend-edge src/hub/projectUrls.ts +
// ownerArrival.ts — NOT imported; _daup-reference must never be copied into the repo):
//   • Project opens at `https://project.daup.co.za/d/hub` with NON-authoritative hints.
//   • Hint query keys: emailHint, houseHint, placeIdHint (one per place id).
//   • duidelik does NOT hold or mint a houseRedeem (that needs a place-session bearer +
//     the seed's /house/session/redeem/issue — the Hub's job, not the SSO receiving
//     side). So the link carries HINTS ONLY; Project authenticates on arrival. This is
//     the fail-safe shape: worst case Project shows its own sign-in, never a silent
//     cross-app credential leak.
//   • Credential-shaped keys (token/email/places/role/…) are NEVER written.

export const PROJECT_HOME = "https://project.daup.co.za";
const PROJECT_HOST = "project.daup.co.za";
const HUB_PATH = "/d/hub";

// Hint query keys (verbatim from the platform handoff contract).
const EMAIL_HINT = "emailHint";
const HOUSE_HINT = "houseHint";
const PLACE_ID_HINT = "placeIdHint";

// Query keys that would be a credential rather than a hint — stripped, never written.
const CREDENTIAL_KEYS = new Set(["token", "email", "places", "hubplaces", "role", "daup_owner", "daup1", "pepper"]);

export interface ProjectLinkContext {
  /** The tile's stored project ref: a full project.daup.co.za URL, or a bare handle
   *  (place id / instance) to open in the place context. Null → no link. */
  daupProjectRef: string | null;
  /** The current place id (house mode), used as a placeIdHint. */
  placeId?: string | null;
  /** Optional email prefill hint. */
  emailHint?: string | null;
  /** Optional house/place display-name hint. */
  houseHint?: string | null;
}

function stripCredentialQuery(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
}

/** True when ref already looks like a project.daup.co.za URL we can open directly. */
export function isProjectUrl(ref: string): boolean {
  try {
    const u = new URL(ref.trim());
    return u.hostname === PROJECT_HOST;
  } catch {
    return false;
  }
}

/**
 * Build the Open-in-Project URL for a tile, or null when the tile has no usable ref.
 *
 *  • A full project.daup.co.za URL in daupProjectRef → used as-is (credential query
 *    stripped for safety), so a human can paste a deep link to a specific project.
 *  • Any other non-empty ref → treated as an opaque handle appended as a placeIdHint
 *    on the /d/hub door (alongside the current placeId), so Project opens in context.
 *  • Empty/null ref → null (no link; the caller shows nothing / a disabled affordance).
 */
export function buildOpenInProjectUrl(ctx: ProjectLinkContext): string | null {
  const ref = (ctx.daupProjectRef || "").trim();
  if (!ref) return null;

  // Case 1: an explicit project.daup.co.za URL — open it directly (strip any credential
  // query a pasted link might carry).
  if (isProjectUrl(ref)) {
    try {
      const u = new URL(ref);
      stripCredentialQuery(u);
      return u.toString();
    } catch {
      return null;
    }
  }

  // Case 2: a bare handle → open Project's /d/hub with hints. The ref and the current
  // placeId both ride as placeIdHint (non-authoritative); Project resolves them.
  const url = new URL(`${PROJECT_HOME}${HUB_PATH}`);
  const email = (ctx.emailHint || "").trim().toLowerCase();
  const house = (ctx.houseHint || "").trim();
  if (email) url.searchParams.set(EMAIL_HINT, email);
  if (house) url.searchParams.set(HOUSE_HINT, house);
  const placeIds = [ctx.placeId, ref].map((x) => (x || "").trim()).filter(Boolean);
  for (const id of placeIds) url.searchParams.append(PLACE_ID_HINT, id);
  stripCredentialQuery(url);
  return url.toString();
}
