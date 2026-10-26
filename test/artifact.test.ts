// daup-duidelik — per-artifact export/import (core/artifact.ts) tests
//
// The pure envelope logic: build a document/glossary artifact, round-trip it through
// parse, and prove the validation rejects malformed / mismatched / wrong-kind files.
// No DOM — these are pure-function tests.

import { describe, it, expect } from "vitest";
import {
  buildDocumentArtifact,
  buildGlossaryArtifact,
  artifactJson,
  artifactFilename,
  parseArtifact,
  productMismatchReason,
  isDocumentArtifact,
  docTypeOf,
  ArtifactError,
  ARTIFACT_FORMAT,
  ARTIFACT_FORMAT_VERSION,
} from "../src/core/artifact";
import { DocType, DocStatus, Role } from "../src/core/enums";
import type { DataProduct, DuidelikDocument, GlossaryTerm, Signature } from "../src/types";

const product: DataProduct = {
  id: "p-1",
  code: "DAPP-6007",
  subDomainId: "sd-1",
  name: "Shepherd — Outbound Transport Plan",
  oneLiner: "one line",
  stage: "BRD",
  ownerId: "u-1",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const brd: DuidelikDocument = {
  id: "d-1",
  dataProductId: "p-1",
  type: DocType.BRD,
  status: DocStatus.SIGNED,
  content: { decision: "Planners decide the per-store allocation each morning.", outOfScope: ["promos"] },
  checklistVersion: "brd-v1",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const signature: Signature = {
  id: "s-1",
  documentId: "d-1",
  signedById: "u-1",
  signedByRole: Role.PRODUCT_OWNER,
  signedAt: "2026-10-26T01:00:00.000Z",
  checklistVersion: "brd-v1",
  checklistSnapshot: [],
  documentHash: "fnv1a-deadbeef",
};

const ctx = {
  product,
  placement: "duidelik › Stream 1 › Supply › Transport",
  placeId: "place-abc",
  resolveUserName: (id: string) => (id === "u-1" ? "C. Willemburg" : id),
  now: new Date("2026-10-26T02:00:00.000Z"),
};

describe("artifact — build a document artifact", () => {
  it("builds a self-describing envelope with header + content + signature context", () => {
    const a = buildDocumentArtifact(brd, signature, ctx);
    expect(a.format).toBe(ARTIFACT_FORMAT);
    expect(a.formatVersion).toBe(ARTIFACT_FORMAT_VERSION);
    expect(a.kind).toBe("BRD");
    expect(a.header.productCode).toBe("DAPP-6007");
    expect(a.header.placement).toContain("Transport");
    expect(a.document.content).toEqual(brd.content);
    // signature is CONTEXT only (name resolved, hash carried) — never re-applied
    expect(a.signature?.signedByName).toBe("C. Willemburg");
    expect(a.signature?.documentHash).toBe("fnv1a-deadbeef");
  });

  it("omits the signature for an unsigned document", () => {
    const a = buildDocumentArtifact({ ...brd, status: DocStatus.DRAFT }, null, ctx);
    expect(a.signature).toBeNull();
  });

  it("derives a SharePoint-safe filename", () => {
    const a = buildDocumentArtifact(brd, signature, ctx);
    expect(artifactFilename(a)).toBe("duidelik-DAPP-6007-BRD.json");
  });
});

describe("artifact — round-trip + validation", () => {
  it("parses what it builds (document)", () => {
    const a = buildDocumentArtifact(brd, signature, ctx);
    const parsed = parseArtifact(artifactJson(a));
    expect(isDocumentArtifact(parsed)).toBe(true);
    if (isDocumentArtifact(parsed)) {
      expect(parsed.kind).toBe("BRD");
      expect(docTypeOf(parsed)).toBe(DocType.BRD);
      expect(parsed.document.content).toEqual(brd.content);
    }
  });

  it("parses what it builds (glossary)", () => {
    const terms: GlossaryTerm[] = [
      { id: "g-1", dataProductId: "p-1", term: "OBD", definition: "Outbound Delivery.", createdAt: "x", updatedAt: "x" },
      { id: "g-2", dataProductId: "p-1", term: "Grain", definition: "The level of one row.", createdAt: "x", updatedAt: "x" },
    ];
    const a = buildGlossaryArtifact(terms, ctx);
    expect(artifactFilename(a)).toBe("duidelik-DAPP-6007-GLOSSARY.json");
    const parsed = parseArtifact(artifactJson(a));
    expect(parsed.kind).toBe("GLOSSARY");
    if (parsed.kind === "GLOSSARY") expect(parsed.terms).toHaveLength(2);
  });

  it("rejects non-JSON", () => {
    expect(() => parseArtifact("not json {{{")).toThrow(ArtifactError);
    try {
      parseArtifact("not json {{{");
    } catch (e) {
      expect((e as ArtifactError).code).toBe("NOT_JSON");
    }
  });

  it("rejects a file that is not a duidelik artifact", () => {
    try {
      parseArtifact(JSON.stringify({ hello: "world" }));
    } catch (e) {
      expect((e as ArtifactError).code).toBe("NOT_ARTIFACT");
    }
  });

  it("rejects an artifact from a newer format version", () => {
    const a = buildDocumentArtifact(brd, signature, ctx) as any;
    a.formatVersion = ARTIFACT_FORMAT_VERSION + 1;
    try {
      parseArtifact(JSON.stringify(a));
    } catch (e) {
      expect((e as ArtifactError).code).toBe("VERSION_AHEAD");
    }
  });

  it("rejects a kind/type mismatch (tampered document type)", () => {
    const a = buildDocumentArtifact(brd, signature, ctx) as any;
    a.document.type = "FSD"; // kind says BRD, body says FSD
    try {
      parseArtifact(JSON.stringify(a));
    } catch (e) {
      expect((e as ArtifactError).code).toBe("TYPE_MISMATCH");
    }
  });

  it("rejects a document artifact with no content", () => {
    const a = buildDocumentArtifact(brd, signature, ctx) as any;
    delete a.document.content;
    try {
      parseArtifact(JSON.stringify(a));
    } catch (e) {
      expect((e as ArtifactError).code).toBe("BAD_DOCUMENT");
    }
  });
});

describe("artifact — product mismatch warning", () => {
  it("returns null when the artifact matches the target product (by code)", () => {
    const a = buildDocumentArtifact(brd, signature, ctx);
    expect(productMismatchReason(a, product)).toBeNull();
  });

  it("returns a reason when importing another product's artifact", () => {
    const a = buildDocumentArtifact(brd, signature, ctx);
    const other: DataProduct = { ...product, id: "p-2", code: "DAPP-9999", name: "Something Else" };
    const reason = productMismatchReason(a, other);
    expect(reason).toBeTruthy();
    expect(reason).toContain("Something Else");
  });
});
