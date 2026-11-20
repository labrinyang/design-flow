import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { checkPrototype, readPrototype } from "../src/core/prototype.ts";

const doc = `<!doctype html>
<html><head>
<style>.btn{color:red}</style>
<script>window.app = { email: "" };</script>
</head>
<body>
  <section data-screen="W00"><h1>Hi</h1><button data-to="S01">Start</button></section>
  <section data-screen="S01" class="pad">
    <input data-id="email">
    <button data-to="S02" data-id="go">Continue</button>
    <a data-to="W00">Back</a>
  </section>
  <section data-screen="S02"><p>Done</p><button data-to="NOPE">Broken</button></section>
  <footer>shared footer</footer>
</body></html>`;

describe("readPrototype", () => {
  it("splits the document into its head and one section per screen, in order", () => {
    const p = readPrototype(doc);
    expect(p.head).toContain(".btn{color:red}");
    expect(p.head).toContain("window.app");
    expect(p.screens.map((s) => s.id)).toEqual(["W00", "S01", "S02"]);
    expect(p.screens[1].html).toContain('<input data-id="email">');
    expect(p.screens[1].html).not.toContain("<h1>Hi</h1>");
  });

  it("keeps each section's own element, so its classes still apply in a frame", () => {
    expect(readPrototype(doc).screens[1].html).toMatch(/^<section data-screen="S01" class="pad">/);
  });

  it("lists every jump in the order it appears, with the line it is on", () => {
    expect(readPrototype(doc).jumps).toEqual([
      { from: "W00", to: "S01", line: 7 },
      { from: "S01", to: "S02", line: 10 },
      { from: "S01", to: "W00", line: 11 },
      { from: "S02", to: "NOPE", line: 13 },
    ]);
  });

  it("ignores sections and jumps that only appear inside HTML comments, and keeps line numbers", () => {
    const p = readPrototype(`<!-- one <section data-screen="ID"> each; data-to="ID" jumps -->\n<section data-screen="A"><b data-to="B">x</b></section>`);
    expect(p.screens.map((s) => [s.id, s.line])).toEqual([["A", 2]]);
    expect(p.jumps).toEqual([{ from: "A", to: "B", line: 2 }]);
  });

  it("does not count data-back (go to the previous screen) as a jump", () => {
    expect(readPrototype(`<section data-screen="A"><a data-back>‹ Back</a><b data-to="B">Next</b></section>`).jumps).toEqual([{ from: "A", to: "B", line: 1 }]);
  });

  it("reads sections nested inside other markup and with single-quoted ids", () => {
    const p = readPrototype(`<main><div><section data-screen='A'><section class="inner">x</section></section></div><section data-screen="B">y</section></main>`);
    expect(p.screens.map((s) => [s.id, s.html])).toEqual([
      ["A", `<section data-screen='A'><section class="inner">x</section></section>`],
      ["B", `<section data-screen="B">y</section>`],
    ]);
  });
});

const flow = parseFlow(
  `version: 1
title: T
screens:
  - { id: W00, title: Welcome }
  - { id: S01, title: Email }
  - { id: S02, title: Done }
  - { id: S03, title: Not drawn yet }
edges:
  - { from: W00, to: S01 }
  - { from: S01, to: S02 }
`,
  "flow.yaml",
).flow as Flow;

describe("checkPrototype", () => {
  it("reports jumps to unknown screens, sections for unknown screens, and screens with no section", () => {
    const issues = checkPrototype(readPrototype(doc + `<section data-screen="Z9"></section>`), flow, "prototype.html");
    expect(issues.map((i) => [i.line, i.message])).toEqual([
      [11, "S01 → W00 has no edge in flow.yaml"],
      [13, "data-to in S02 goes to unknown screen NOPE"],
      [15, "section Z9 is not a screen in flow.yaml"],
      [1, "screen S03 has no <section data-screen=\"S03\"> in prototype.html"],
    ]);
  });

  it("reports a jump that flow.yaml has no edge for, but not a back edge it already draws", () => {
    const withBack = parseFlow(
      `version: 1
title: T
screens: [{ id: W00, title: W }, { id: S01, title: E }, { id: S02, title: D }, { id: S03, title: X }]
edges:
  - { from: W00, to: S01 }
  - { from: S01, to: S02 }
  - { from: S01, to: W00, kind: back }
`,
      "flow.yaml",
    ).flow as Flow;
    const messages = checkPrototype(readPrototype(doc), withBack, "prototype.html").map((i) => i.message);
    expect(messages).not.toContain("S01 → W00 has no edge in flow.yaml");
    const without = checkPrototype(readPrototype(doc), flow, "prototype.html").map((i) => i.message);
    expect(without).toContain("S01 → W00 has no edge in flow.yaml");
  });
});
