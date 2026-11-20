import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { playDocument } from "../web/src/play-doc.ts";

const flow = parseFlow(
  `version: 1
title: T
viewport: { width: 390, height: 844 }
style: <style>.shared{}</style>
screens:
  - { id: A, title: Alpha, html: '<button data-to="B">Go</button>' }
  - { id: B, title: Beta, html: '<p>Beta</p>' }
`,
  "t",
).flow as Flow;

const proto = `<!doctype html><html><head><style>.p{}</style><script>window.n=1</script></head>
<body><section data-screen="A"><button data-to="B">Go</button></section><section data-screen="B"><p>b</p></section></body></html>`;

describe("playDocument", () => {
  it("runs the whole prototype as written, locked down like a frame", () => {
    const doc = playDocument(flow, proto, { start: "A", channel: "c" });
    expect(doc).toContain("window.n=1");
    expect(doc).toContain(`<section data-screen="B"><p>b</p></section>`);
    expect(doc).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src 'none'/);
    expect(doc).toContain('"A"');
  });

  it("builds a prototype from per-screen html when there is no prototype.html", () => {
    const doc = playDocument(flow, undefined, { start: "B", channel: "c" });
    expect(doc).toContain(".shared{}");
    expect(doc).toContain(`<section data-screen="A"><button data-to="B">Go</button></section>`);
    expect(doc).toContain(`<section data-screen="B"><p>Beta</p></section>`);
  });

  it("sends data-back to the previous screen", () => {
    expect(playDocument(flow, proto, { start: "A", channel: "c" })).toContain("[data-back]");
  });

  it("passes Escape out to the host, since focus sits inside the frame after a tap", () => {
    expect(playDocument(flow, proto, { start: "A", channel: "c" })).toMatch(/Escape[^\n]*type:"escape"/);
  });

  it("puts the CSP ahead of anything the prototype's own head loads", () => {
    const doc = playDocument(flow, proto, { start: "A", channel: "c" });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("window.n=1"));
  });
});
