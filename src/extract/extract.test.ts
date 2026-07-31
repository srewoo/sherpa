import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { extractPage } from "./extract.js";
import { detectPlatform } from "./profiles.js";
import type { Block } from "@/domain/content.js";

function doc(html: string): Document {
  return parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
    .document as unknown as Document;
}
function extract(html: string) {
  return extractPage(doc(html), "https://docs.northwind.com/guide");
}

const SAMPLE = `
  <nav aria-label="Breadcrumb"><a>Admin</a><a>API Keys</a><a>Rotation</a></nav>
  <nav class="site-nav"><a>Home</a><a>Pricing</a></nav>
  <main>
    <h1>Rotating API Keys</h1>
    <p>Rotate with zero downtime.</p>
    <h2 id="steps">Steps</h2>
    <ol>
      <li>Open <strong>Admin</strong></li>
      <li>Generate successor</li>
    </ol>
    <pre><code class="language-bash">nw keys rotate --id 42</code></pre>
    <table>
      <thead><tr><th>Window</th><th>Max</th></tr></thead>
      <tbody><tr><td>30 days</td><td>90 days</td></tr></tbody>
    </table>
    <details><summary>More</summary><p>Hidden detail here.</p></details>
    <div class="was-this-helpful">Was this helpful?</div>
  </main>
  <footer>© Northwind</footer>
`;

describe("extractPage", () => {
  const page = extract(SAMPLE);
  const byType = (t: Block["type"]) => page.blocks.filter((b) => b.type === t);

  it("takes the title from the h1", () => {
    expect(page.title).toBe("Rotating API Keys");
  });

  it("captures the breadcrumb trail", () => {
    expect(page.breadcrumb).toEqual(["Admin", "API Keys", "Rotation"]);
  });

  it("captures heading anchors for deep links", () => {
    const h2 = byType("heading").find((b) => b.text === "Steps");
    expect(h2?.anchor).toBe("steps");
    expect(h2?.level).toBe(2);
  });

  it("preserves an ordered list as numbered structure", () => {
    const list = byType("list")[0];
    expect(list?.text).toContain("1. Open Admin");
    expect(list?.text).toContain("2. Generate successor");
  });

  it("preserves a code block verbatim with language hint", () => {
    const code = byType("code")[0];
    expect(code?.text).toBe("```bash\nnw keys rotate --id 42\n```");
  });

  it("renders a table as markdown", () => {
    const table = byType("table")[0];
    expect(table?.text).toContain("| Window | Max |");
    expect(table?.text).toContain("| 30 days | 90 days |");
  });

  it("expands collapsed <details> content", () => {
    expect(byType("paragraph").some((b) => b.text.includes("Hidden detail"))).toBe(true);
  });

  it("strips site nav, footer and the was-this-helpful widget", () => {
    const all = page.blocks.map((b) => b.text).join(" ");
    expect(all).not.toContain("Pricing");
    expect(all).not.toContain("Northwind ©");
    expect(all).not.toContain("Was this helpful");
  });
});

describe("platform profiles (PRD 5.1.7)", () => {
  it("detects a platform from the generator meta", () => {
    const d = parseHTML('<html><head><meta name="generator" content="Docusaurus v3.1"></head><body></body></html>');
    expect(detectPlatform(d.document as unknown as Document)).toBe("docusaurus");
  });

  it("detects a platform from DOM signatures", () => {
    expect(detectPlatform(doc('<div class="article-body">x</div>'))).toBe("zendesk");
    expect(detectPlatform(doc('<div id="__docusaurus"></div>'))).toBe("docusaurus");
    expect(detectPlatform(doc("<div>plain</div>"))).toBe("generic");
  });

  it("uses the platform content root and strips platform chrome", () => {
    const page = extract(`
      <div class="pagination-nav"><a>Next page</a></div>
      <article class="theme-doc-markdown">
        <h1>Configure SSO</h1>
        <p>Set the audience URL.</p>
      </article>
      <div class="theme-doc-toc-desktop"><a>On this page</a></div>
    `);
    expect(page.platform).toBe("docusaurus");
    const text = page.blocks.map((b) => b.text).join(" ");
    expect(text).toContain("Set the audience URL");
    expect(text).not.toContain("Next page");
    expect(text).not.toContain("On this page");
  });
});
