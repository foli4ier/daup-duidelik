// daup-duidelik — remote store client tests (STACK §5 durable persistence).
//
// Proves the client: reads a 200 graph, treats 204 as "no data yet", fails SOFT on a
// network error / non-200 (never throws), sends the bearer, and rejects bad inputs.

import { describe, it, expect, vi } from "vitest";
import { fetchRemoteGraph, pushRemoteGraph } from "../src/api/remoteStore";
import type { StoreGraph } from "../src/types";

const SEED = "https://mcp.daup.co.za";
const PLACE = "place-123";
const BEARER = "abcdef0123456789_bearer-token";

function graph(): StoreGraph {
  return {
    schemaVersion: 3,
    streams: [],
    domains: [],
    subDomains: [],
    dataProducts: [],
    documents: [],
    glossaryTerms: [],
    rigourChecks: [],
    signatures: [],
    users: [],
    members: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("remoteStore.fetchRemoteGraph", () => {
  it("returns the graph on 200 and sends the bearer", async () => {
    const g = graph();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${BEARER}`);
      return jsonResponse(200, g);
    });
    const r = await fetchRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph?.schemaVersion).toBe(3);
  });

  it("treats 204 as no-data (graph null)", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(204, null));
    const r = await fetchRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph).toBeNull();
  });

  it("fails soft (no throw) on a network error", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    });
    const r = await fetchRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, fetchImpl });
    expect(r.ok).toBe(false);
  });

  it("fails on a non-200 status", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(403, { error: "nope" }));
    const r = await fetchRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects an invalid bearer without calling fetch", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, graph()));
    const r = await fetchRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: "short", fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("remoteStore.pushRemoteGraph", () => {
  it("PUTs the graph and returns ok on 200", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(typeof init?.body).toBe("string");
      return jsonResponse(200, { ok: true });
    });
    const r = await pushRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, graph: graph(), fetchImpl });
    expect(r.ok).toBe(true);
  });

  it("fails soft on a non-200", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(500, { error: "boom" }));
    const r = await pushRemoteGraph({ seedOrigin: SEED, placeId: PLACE, bearer: BEARER, graph: graph(), fetchImpl });
    expect(r.ok).toBe(false);
  });
});
