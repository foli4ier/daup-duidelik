// daup-duidelik — Roadmap kanban store intents (vitest).
//
// Proves the per-product roadmap mutation surface:
//   ADD_ROADMAP_ITEM    — creates a tile in a column, appended at the end (order grows).
//   EDIT_ROADMAP_ITEM   — updates title/note/link; a blank title is refused.
//   MOVE_ROADMAP_ITEM   — moves a tile between columns (re-ordered to the column end).
//   REMOVE_ROADMAP_ITEM — deletes a tile.
// A roadmap tile NEVER touches document status, rigour or signatures — it is ungated
// authoring scoped to one dataProductId (like the glossary).

import { describe, it, expect } from "vitest";
import { createStore } from "../src/core";
import { memoryAdapter } from "../src/api/persistence";

function counterId() {
  let n = 0;
  return () => "id-" + String(++n).padStart(6, "0");
}
const fixedClock = () => new Date("2026-10-26T12:00:00.000Z");
function freshStore() {
  return createStore({ adapter: memoryAdapter(), genId: counterId(), clock: fixedClock });
}
// DAPP-6036 ships in the standalone seed.
function aProduct(s: ReturnType<typeof freshStore>) {
  return s.getState().dataProducts.find((p) => p.code === "DAPP-6036")!;
}

describe("Roadmap — add / order / columns", () => {
  it("adds tiles into columns and appends them (order grows per column)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;

    const a = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Flash Sales Plan" }) as any;
    const b = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Second current" }) as any;
    const c = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "PLANNED", title: "A planned one" }) as any;

    expect(a.ok && b.ok && c.ok).toBe(true);
    const items = s.roadmapForProduct(pid);
    expect(items.length).toBe(3);

    const current = items.filter((r) => r.column === "CURRENT");
    expect(current.map((r) => r.title)).toEqual(["Flash Sales Plan", "Second current"]);
    // order is per-column and strictly increasing
    expect(current[0].order).toBeLessThan(current[1].order);
    // the planned column starts its own order sequence
    expect(items.find((r) => r.column === "PLANNED")!.order).toBe(0);
  });

  it("refuses a tile with no title", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const res = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "FUTURE", title: "   " }) as any;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("EMPTY");
    expect(s.roadmapForProduct(pid).length).toBe(0);
  });

  it("stores an optional link to a registry product", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const other = s.getState().dataProducts.find((p) => p.id !== pid)!;
    const res = s.dispatch({
      type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Linked", linkedProductId: other.id,
    }) as any;
    expect(res.ok).toBe(true);
    expect(res.item.linkedProductId).toBe(other.id);
  });

  it("stores and clears an optional daup-projects reference (A-i seam)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({
      type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "P",
      daupProjectRef: "https://project.daup.co.za/p/x",
    }) as any;
    expect(add.ok).toBe(true);
    expect(add.item.daupProjectRef).toBe("https://project.daup.co.za/p/x");

    // Editing with daupProjectRef: null clears it (undefined would leave it).
    const cleared = s.dispatch({ type: "EDIT_ROADMAP_ITEM", itemId: add.item.id, daupProjectRef: null }) as any;
    expect(cleared.ok).toBe(true);
    expect(cleared.item.daupProjectRef).toBeNull();
  });
});

describe("Roadmap — edit / move / remove", () => {
  it("edits a tile's title/note/link; a blank title on edit is refused", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Orig" }) as any;
    const id = add.item.id;

    const ok = s.dispatch({ type: "EDIT_ROADMAP_ITEM", itemId: id, title: "New title", note: "a note" }) as any;
    expect(ok.ok).toBe(true);
    expect(ok.item.title).toBe("New title");
    expect(ok.item.note).toBe("a note");

    const bad = s.dispatch({ type: "EDIT_ROADMAP_ITEM", itemId: id, title: "  " }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("EMPTY");
    // unchanged
    expect(s.roadmapForProduct(pid)[0].title).toBe("New title");
  });

  it("moves a tile to another column (re-ordered to that column's end)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "PLANNED", title: "P0" });
    const add = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "C0" }) as any;
    const id = add.item.id;

    const moved = s.dispatch({ type: "MOVE_ROADMAP_ITEM", itemId: id, column: "PLANNED" }) as any;
    expect(moved.ok).toBe(true);
    expect(moved.item.column).toBe("PLANNED");
    // it lands after the existing PLANNED tile
    const planned = s.roadmapForProduct(pid).filter((r) => r.column === "PLANNED");
    expect(planned.map((r) => r.title)).toEqual(["P0", "C0"]);
    expect(s.roadmapForProduct(pid).filter((r) => r.column === "CURRENT").length).toBe(0);
  });

  it("removes a tile", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "FUTURE", title: "Gone soon" }) as any;
    const rm = s.dispatch({ type: "REMOVE_ROADMAP_ITEM", itemId: add.item.id }) as any;
    expect(rm.ok).toBe(true);
    expect(s.roadmapForProduct(pid).length).toBe(0);
  });

  it("a roadmap change never touches document status (no lifecycle/gate interaction)", () => {
    const s = freshStore();
    const p = aProduct(s); // DAPP-6036 — BRD is SIGNED
    const brdBefore = s.docOf(p.id, "BRD")!.status;
    s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: p.id, column: "CURRENT", title: "No cascade" });
    expect(s.docOf(p.id, "BRD")!.status).toBe(brdBefore); // still SIGNED — unaffected
  });
});

describe("Roadmap — project charter", () => {
  it("stores a structured charter on add (fields trimmed, lists cleaned)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({
      type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Charter tile",
      charter: {
        purpose: "  Replace the manual ECC flash-sales pull.  ",
        scope: "GM flash sales only",
        objectives: "Automate the daily feed",
        sponsor: "G. Smith",
        stakeholders: ["  BA team  ", "", "Finance"],
        milestones: ["Kickoff — Q1", "   ", "Go-live — Q3"],
        risks: "ECC extract window may move",
      },
    }) as any;
    expect(add.ok).toBe(true);
    const c = add.item.charter;
    expect(c).not.toBeNull();
    expect(c.purpose).toBe("Replace the manual ECC flash-sales pull."); // trimmed
    expect(c.stakeholders).toEqual(["BA team", "Finance"]); // blanks dropped
    expect(c.milestones).toEqual(["Kickoff — Q1", "Go-live — Q3"]); // blank dropped
  });

  it("collapses an all-empty charter to null (not a bag of empty strings)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({
      type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "No charter",
      charter: { purpose: "  ", scope: "", objectives: "", sponsor: "", stakeholders: ["", "  "], milestones: [], risks: "" },
    }) as any;
    expect(add.ok).toBe(true);
    expect(add.item.charter).toBeNull();
  });

  it("a tile added with no charter has a null/absent charter", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({ type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "Plain" }) as any;
    expect(add.ok).toBe(true);
    expect(add.item.charter ?? null).toBeNull();
  });

  it("edits the charter (undefined leaves it; a new object replaces it; empty clears to null)", () => {
    const s = freshStore();
    const pid = aProduct(s).id;
    const add = s.dispatch({
      type: "ADD_ROADMAP_ITEM", productId: pid, column: "CURRENT", title: "T",
      charter: { purpose: "P1", scope: "", objectives: "", sponsor: "", stakeholders: [], milestones: [], risks: "" },
    }) as any;
    const id = add.item.id;
    expect(add.item.charter.purpose).toBe("P1");

    // Editing other fields WITHOUT passing charter leaves the charter intact.
    const keep = s.dispatch({ type: "EDIT_ROADMAP_ITEM", itemId: id, note: "n" }) as any;
    expect(keep.item.charter.purpose).toBe("P1");

    // Passing a new charter replaces it.
    const repl = s.dispatch({
      type: "EDIT_ROADMAP_ITEM", itemId: id,
      charter: { purpose: "P2", scope: "", objectives: "", sponsor: "", stakeholders: [], milestones: [], risks: "" },
    }) as any;
    expect(repl.item.charter.purpose).toBe("P2");

    // Passing an all-empty charter clears it to null.
    const clr = s.dispatch({
      type: "EDIT_ROADMAP_ITEM", itemId: id,
      charter: { purpose: "", scope: "", objectives: "", sponsor: "", stakeholders: [], milestones: [], risks: "" },
    }) as any;
    expect(clr.item.charter).toBeNull();
  });
});

describe("Roadmap — persistence / migration", () => {
  it("an older blob with no roadmapItems migrates to an empty array (no crash)", () => {
    // A v3 blob (pre-roadmap) with roadmapItems absent.
    const v3 = {
      schemaVersion: 3,
      streams: [], domains: [], subDomains: [], dataProducts: [], documents: [],
      glossaryTerms: [], rigourChecks: [], signatures: [], users: [], members: [],
    };
    const s = createStore({ adapter: memoryAdapter(v3 as any), genId: counterId(), clock: fixedClock });
    expect(s.getState().schemaVersion).toBe(s.SCHEMA_VERSION);
    expect(Array.isArray(s.getState().roadmapItems)).toBe(true);
    expect(s.roadmapForProduct("whatever")).toEqual([]);
  });
});
