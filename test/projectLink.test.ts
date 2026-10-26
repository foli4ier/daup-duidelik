// daup-duidelik — Open-in-Project link builder (A-i). Pure URL contract test.
//
// Proves the deep-link handshake mirrored from the platform contract:
//   • a full Project URL (plural OR legacy host) is opened directly, a legacy-host
//     link normalised onto the plural host, credential query stripped;
//   • a bare handle opens projects.daup.co.za/d/hub with placeIdHint(s);
//   • the current placeId rides as a hint alongside the ref;
//   • credential-shaped query keys are NEVER emitted;
//   • no ref → null (no button).

import { describe, it, expect } from "vitest";
import { buildOpenInProjectUrl, isProjectUrl, PROJECT_HOME } from "../src/api/projectLink";

describe("projectLink — buildOpenInProjectUrl", () => {
  it("returns null when there is no ref", () => {
    expect(buildOpenInProjectUrl({ daupProjectRef: null, placeId: "place-1" })).toBeNull();
    expect(buildOpenInProjectUrl({ daupProjectRef: "   ", placeId: "place-1" })).toBeNull();
  });

  it("opens a bare handle on /d/hub with the handle + placeId as placeIdHint", () => {
    const url = buildOpenInProjectUrl({ daupProjectRef: "proj-123", placeId: "place-abc" })!;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${PROJECT_HOME}/d/hub`);
    expect(u.hostname).toBe("projects.daup.co.za"); // plural host after the repoint
    const hints = u.searchParams.getAll("placeIdHint");
    expect(hints).toContain("place-abc"); // current place context
    expect(hints).toContain("proj-123"); // the tile's ref
  });

  it("includes optional email/house hints when provided, lowercased email", () => {
    const url = buildOpenInProjectUrl({
      daupProjectRef: "proj-9",
      placeId: null,
      emailHint: "Owner@Example.COM",
      houseHint: "Shoprite BW Team",
    })!;
    const u = new URL(url);
    expect(u.searchParams.get("emailHint")).toBe("owner@example.com");
    expect(u.searchParams.get("houseHint")).toBe("Shoprite BW Team");
    expect(u.searchParams.getAll("placeIdHint")).toEqual(["proj-9"]); // no placeId → only the ref
  });

  it("uses a full plural-host plan URL verbatim (the user's case)", () => {
    const ref = "https://projects.daup.co.za/p/demo-daup-11386-s4";
    const url = buildOpenInProjectUrl({ daupProjectRef: ref, placeId: "place-x" })!;
    expect(url).toBe(ref); // direct open — no /d/hub, no placeIdHint mangling
    const u = new URL(url);
    expect(u.pathname).toBe("/p/demo-daup-11386-s4");
    expect(u.searchParams.has("placeIdHint")).toBe(false);
  });

  it("normalises a legacy-host plan URL onto the plural host (opens the live app)", () => {
    const ref = "https://project.daup.co.za/p/analytics-transformation";
    const url = buildOpenInProjectUrl({ daupProjectRef: ref, placeId: "place-x" })!;
    const u = new URL(url);
    expect(u.hostname).toBe("projects.daup.co.za"); // repointed from the legacy host
    expect(u.pathname).toBe("/p/analytics-transformation"); // path preserved
    expect(u.searchParams.has("placeIdHint")).toBe(false); // still a direct open, not a hint
  });

  it("strips a credential-shaped query from a pasted project URL", () => {
    const ref = "https://projects.daup.co.za/p/x?token=abc&role=PRODUCT_OWNER&foo=keep";
    const url = buildOpenInProjectUrl({ daupProjectRef: ref, placeId: null })!;
    const u = new URL(url);
    expect(u.searchParams.has("token")).toBe(false);
    expect(u.searchParams.has("role")).toBe(false);
    expect(u.searchParams.get("foo")).toBe("keep"); // non-credential query preserved
  });

  it("never emits a credential key on the bare-handle /d/hub URL", () => {
    const url = buildOpenInProjectUrl({ daupProjectRef: "h", placeId: "p", emailHint: "a@b.co" })!;
    const u = new URL(url);
    for (const banned of ["token", "role", "places", "hubplaces", "daup_owner"]) {
      expect(u.searchParams.has(banned)).toBe(false);
    }
  });

  it("isProjectUrl recognises BOTH the plural and legacy Project hosts", () => {
    expect(isProjectUrl("https://projects.daup.co.za/p/x")).toBe(true); // plural (new)
    expect(isProjectUrl("https://project.daup.co.za/p/x")).toBe(true); // legacy (parallel run)
    expect(isProjectUrl("https://evil.example.com/projects.daup.co.za")).toBe(false);
    expect(isProjectUrl("not a url")).toBe(false);
  });
});
