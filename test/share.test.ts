import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { shareDocument } from "../src/core/share.ts";

const flow = parseFlow(
  `version: 1
title: Sign <up> & in
viewport: { width: 390, height: 844 }
screens:
  - { id: A, title: Alpha, html: '<button data-to="B">Go</button>' }
  - { id: B, title: Beta, html: '<p>Beta</p>' }
`,
  "t",
).flow as Flow;

describe("shareDocument", () => {
  const doc = shareDocument(flow, undefined, { start: "A" });

  it("is one self-contained page: no scripts or styles fetched from anywhere", () => {
    expect(doc).not.toMatch(/<script[^>]+src=/i);
    expect(doc).not.toMatch(/<link[^>]+href=/i);
    expect(doc).toMatch(/^<!doctype html>/i);
  });

  it("carries the flow's title, escaped, and every screen as a stop", () => {
    expect(doc).toContain("<title>Sign &lt;up&gt; &amp; in</title>");
    expect(doc).toContain('data-go="A"');
    expect(doc).toContain('data-go="B"');
  });

  it("runs the screens in a sandboxed frame at the flow's viewport, starting at the chosen screen", () => {
    expect(doc).toMatch(/<iframe[^>]+sandbox="allow-scripts"/);
    expect(doc).toContain("390");
    expect(doc).toContain("844");
    // The frame's document is embedded as a string, so its own markup cannot close the host's tags.
    expect(doc).not.toContain('<section data-screen="A">');
  });
});
