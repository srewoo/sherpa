import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml, htmlToText } from "./markdown.js";

describe("escapeHtml", () => {
  it("neutralises every markup character", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});

describe("renderMarkdown", () => {
  it("keeps numbered steps as an ordered list (5.8.10)", () => {
    const html = renderMarkdown("1. First step\n2. Second step");
    expect(html).toBe("<ol><li>First step</li><li>Second step</li></ol>");
  });

  it("renders bullets, bold and inline code", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("**Admin**")).toBe("<p><strong>Admin</strong></p>");
    expect(renderMarkdown("use `--flag` here")).toBe("<p>use <code>--flag</code> here</p>");
  });

  it("renders fenced code verbatim", () => {
    const html = renderMarkdown("```js\nconst x = 1 < 2;\n```");
    expect(html).toBe("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });

  it("shows a fence that is still streaming", () => {
    expect(renderMarkdown("```\nhalf a block")).toContain("<pre><code>half a block");
  });

  it("turns [n] into a citation chip linked to its source card", () => {
    const html = renderMarkdown("Rotate the key [2].");
    expect(html).toContain('href="#source-2"');
    expect(html).toContain('data-cite="2"');
  });

  it("never emits markup from model output", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("closes a list before a following paragraph", () => {
    expect(renderMarkdown("1. step\n\nAfter.")).toBe("<ol><li>step</li></ol><p>After.</p>");
  });
});

describe("htmlToText", () => {
  it("recovers plain text for the clipboard", () => {
    const text = htmlToText("<p>Do this</p><ol><li>one</li><li>two</li></ol>");
    expect(text).toBe("Do this\n- one\n- two");
  });

  it("unescapes entities", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
  });
});

/**
 * A chip that looks like a citation but scrolls nowhere is worse than no chip:
 * it presents an unverifiable claim as sourced. Models handed five sources do
 * write [6].
 */
describe("citation bounds", () => {
  it("links a citation that has a source", () => {
    expect(renderMarkdown("Do the thing [2].", 5)).toContain('href="#source-2"');
  });

  it("leaves a citation beyond the source list as plain text", () => {
    const html = renderMarkdown("Do the thing [6].", 5);
    expect(html).not.toContain("#source-6");
    expect(html).toContain("[6]");
  });

  it("rejects [0], which no source can ever be", () => {
    expect(renderMarkdown("Nonsense [0].", 5)).not.toContain("#source-0");
  });

  it("drops every citation when there are no sources at all", () => {
    expect(renderMarkdown("Ungrounded [1].", 0)).not.toContain("cite");
  });

  it("still renders the surrounding markdown around a rejected citation", () => {
    const html = renderMarkdown("1. **Step** [9]", 2);
    expect(html).toContain("<strong>Step</strong>");
    expect(html).toContain("<ol>");
  });
});
