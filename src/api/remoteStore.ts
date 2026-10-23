// daup-duidelik — remote registry store client (STACK §5 durable persistence).
//
// In house mode the registry is persisted on the place's own seed node (the sovereign
// per-node data domain, CONCEPT §9) via the seed endpoints:
//
//   GET  {seed}/duidelik/store/:placeId   -> the StoreGraph JSON (200), or 204 if none
//   PUT  {seed}/duidelik/store/:placeId   body: StoreGraph JSON -> { ok: true }
//
// This is the server-side half of the persistence seam (DAUP-PORT-PLAN §3 / STACK §5):
// localStorage stays the LOCAL cache + offline buffer; the seed is the DURABLE source of
// truth that survives a new browser/device and is shared across the place's members (O2).
//
// Discipline mirrors api/houseSession.ts: bearer sent as Authorization + credentials
// included (the seed's host-only cookie); every error path FAILS SOFT (returns a result,
// never throws) so a seed hiccup degrades to local-only, never breaks the app.

import type { StoreGraph } from "../types";
import { normalizeSeedOrigin } from "./houseSession";

export type FetchLike = typeof fetch;

const PLACE_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const BEARER_RE = /^[A-Za-z0-9._-]{16,4000}$/;

export type RemoteReadResult =
  | { ok: true; graph: StoreGraph | null } // null = no registry stored yet (204)
  | { ok: false; error: string; status?: number };

export type RemoteWriteResult = { ok: true } | { ok: false; error: string; status?: number };

function endpoint(origin: string, placeId: string): string {
  return `${origin}/duidelik/store/${encodeURIComponent(placeId)}`;
}

function guard(seedOrigin: string, placeId: string, bearer: string): string | null {
  if (!normalizeSeedOrigin(seedOrigin)) return "seed origin is invalid";
  if (!PLACE_RE.test(placeId)) return "placeId is invalid";
  if (!BEARER_RE.test(bearer)) return "bearer is invalid";
  return null;
}

/** Read the durable registry for a place. 204 → { graph: null } (no data yet). */
export async function fetchRemoteGraph(input: {
  seedOrigin: string;
  placeId: string;
  bearer: string;
  fetchImpl?: FetchLike;
}): Promise<RemoteReadResult> {
  const origin = normalizeSeedOrigin(input.seedOrigin)!;
  const bad = guard(input.seedOrigin, input.placeId, input.bearer);
  if (bad) return { ok: false, error: bad };

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(endpoint(origin, input.placeId), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${input.bearer}` },
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "seed request failed" };
  }

  if (res.status === 204) return { ok: true, graph: null };
  if (res.status !== 200) {
    return { ok: false, error: `read failed (${res.status})`, status: res.status };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "registry response was not JSON", status: res.status };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "registry response was not an object", status: res.status };
  }
  if (typeof (body as { schemaVersion?: unknown }).schemaVersion !== "number") {
    return { ok: false, error: "registry has no schemaVersion", status: res.status };
  }
  return { ok: true, graph: body as StoreGraph };
}

/** Persist the registry for a place (write-through on every committed change). */
export async function pushRemoteGraph(input: {
  seedOrigin: string;
  placeId: string;
  bearer: string;
  graph: StoreGraph;
  fetchImpl?: FetchLike;
}): Promise<RemoteWriteResult> {
  const origin = normalizeSeedOrigin(input.seedOrigin)!;
  const bad = guard(input.seedOrigin, input.placeId, input.bearer);
  if (bad) return { ok: false, error: bad };

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(endpoint(origin, input.placeId), {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${input.bearer}` },
      body: JSON.stringify(input.graph),
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "seed request failed" };
  }
  if (res.status !== 200) {
    return { ok: false, error: `write failed (${res.status})`, status: res.status };
  }
  return { ok: true };
}
