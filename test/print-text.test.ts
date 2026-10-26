// daup-duidelik — printed free-text rendering (renderRichText) tests
//
// Guards the BRD "Business decision" print readability fix: an enumerated run-on
// ("1. … 2. … 3. …") must print as an ordered list, not one wall of prose; plain text
// keeps paragraphs/line breaks; inner periods ("GEB vs.", "(CFO)") must NOT split; and
// everything is HTML-escaped (no injection from author content).

import { describe, it, expect } from "vitest";
import { renderRichText, escapeHtml, renderObjectArrayTable, titleCase } from "../src/pages/Product";

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

describe("renderObjectArrayTable — object arrays print as a grid", () => {
  it("renders success metrics as a table with title-cased headers and one row per metric", () => {
    const metrics = [
      { metric: "Adoption Rate", baseline: "50 %", target: "80 %", by: "end of 2028" },
      { metric: "SLA Delivery Adherence", baseline: "98 %", target: "99 %", by: "end of 2028" },
    ];
    const html = renderObjectArrayTable(metrics);
    expect(html).toContain("<table");
    expect(html).toContain("<th>Metric</th>");
    expect(html).toContain("<th>Baseline</th>");
    expect(html).toContain("<th>Target</th>");
    expect(html).toContain("<th>By</th>");
    // one <tr> in thead + one per metric row
    expect((html.match(/<tbody>[\s\S]*<\/tbody>/) || [""])[0].match(/<tr>/g)!.length).toBe(2);
    expect(html).toContain("<td>Adoption Rate</td>");
    expect(html).toContain("<td>80 %</td>");
  });

  it("unions columns across rows in first-seen order and dashes empty cells", () => {
    const rows = [
      { name: "ERP Sales Ledger", type: "Transaction Engine" },
      { name: "Store Master Data", type: "Profit Center Registry", owner: "Finance" },
    ];
    const html = renderObjectArrayTable(rows);
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<th>Type</th>");
    expect(html).toContain("<th>Owner</th>"); // appears from row 2, still a column
    // row 1 has no owner → dash cell
    expect(html).toContain("—");
  });

  it("escapes cell content", () => {
    const html = renderObjectArrayTable([{ name: "<x> & 'y'", type: "t" }]);
    expect(html).not.toContain("<x>");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("titleCase", () => {
  it("humanises content field keys", () => {
    expect(titleCase("metric")).toBe("Metric");
    expect(titleCase("brdRef")).toBe("Brd Ref");
    expect(titleCase("owner_name")).toBe("Owner Name");
  });
});
