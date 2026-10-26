// daup-duidelik — printed free-text rendering (renderRichText) tests
//
// Guards the BRD "Business decision" print readability fix: an enumerated run-on
// ("1. … 2. … 3. …") must print as an ordered list, not one wall of prose; plain text
// keeps paragraphs/line breaks; inner periods ("GEB vs.", "(CFO)") must NOT split; and
// everything is HTML-escaped (no injection from author content).

import { describe, it, expect } from "vitest";
import { renderRichText, escapeHtml } from "../src/pages/Product";

describe("renderRichText — numbered enumerations", () => {
  it("renders a 1. 2. 3. run-on as an ordered list with the markers stripped", () => {
    const raw =
      "1. GEB vs. Total Business: isolate same-store sales. 2. CEO & COO: corporate resource allocation. 3. CFO: CapEx approvals.";
    const html = renderRichText(raw);
    expect(html).toContain('<ol class="decision-list">');
    expect((html.match(/<li>/g) || []).length).toBe(3);
    // leading "N." stripped from each item
    expect(html).toContain("<li>GEB vs. Total Business: isolate same-store sales.</li>");
    expect(html).toContain("<li>CFO: CapEx approvals.</li>");
    // inner period in "GEB vs." did not cause a spurious split
    expect((html.match(/<li>/g) || []).length).toBe(3);
  });

  it("does NOT make a list from a single enumerator", () => {
    const html = renderRichText("1. Only one point here.");
    expect(html).not.toContain("<ol");
    expect(html).toContain("<p>");
  });
});

describe("renderRichText — plain text", () => {
  it("wraps a single paragraph in <p>", () => {
    const html = renderRichText("Planners decide the per-store allocation each morning.");
    expect(html).toBe("<p>Planners decide the per-store allocation each morning.</p>");
  });

  it("splits blank-line paragraphs and keeps single newlines as <br>", () => {
    const html = renderRichText("First para line one\nline two\n\nSecond para");
    expect(html).toBe("<p>First para line one<br>line two</p><p>Second para</p>");
  });

  it("shows an em-dash placeholder for empty", () => {
    expect(renderRichText("")).toContain("—");
    expect(renderRichText(null)).toContain("—");
  });
});

describe("renderRichText — escaping", () => {
  it("escapes HTML in both list and paragraph modes", () => {
    const list = renderRichText("1. <script>alert(1)</script> item. 2. second & <b>bold</b>.");
    expect(list).not.toContain("<script>");
    expect(list).toContain("&lt;script&gt;");
    expect(list).toContain("&amp;");
    const para = renderRichText('A "quoted" <tag> & more');
    expect(para).toContain("&quot;");
    expect(para).toContain("&lt;tag&gt;");
    expect(para).toContain("&amp;");
  });

  it("escapeHtml handles the five special chars", () => {
    expect(escapeHtml('& < > "')).toBe("&amp; &lt; &gt; &quot;");
  });
});
