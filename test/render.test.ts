import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { describeTree, findElement, ownText } from "../src/cli/inspect.ts";
import { findBrowser, launchBrowser, screenPage } from "../src/cli/render.ts";
import { selectorFor } from "../src/core/selector.ts";
import { screenDocument } from "../web/src/screen-doc.ts";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "bin", "design-flow.js");
const SKILL_BIN = join(import.meta.dirname, "..", "skills", "design-flow", "scripts", "design-flow.mjs");
const browser = (() => {
  try {
    return findBrowser();
  } catch {
    return undefined;
  }
})();
const pngSize = (file: string) => {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

describe("findBrowser", () => {
  it("takes DESIGN_FLOW_CHROME first, and names it when that is not a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-browser-"));
    const exe = join(dir, "my-chrome");
    writeFileSync(exe, "");
    expect(findBrowser({ DESIGN_FLOW_CHROME: exe, PATH: "" }, "linux")).toBe(exe);
    expect(() => findBrowser({ DESIGN_FLOW_CHROME: join(dir, "missing"), PATH: "" }, "linux")).toThrow(/DESIGN_FLOW_CHROME/);
  });

  it("looks on PATH on Linux, and says how to point at a browser when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-browser-"));
    expect(() => findBrowser({ PATH: dir }, "linux")).toThrow(/none was found.*DESIGN_FLOW_CHROME/);
    writeFileSync(join(dir, "chromium"), "");
    expect(findBrowser({ PATH: `/nonexistent:${dir}` }, "linux")).toBe(join(dir, "chromium"));
  });
});

describe("screenPage", () => {
  const flow = parseFlow(
    `version: 1
title: T
style: <style>.btn{color:red}</style>
screens:
  - { id: A, title: A, html: '<button class="btn">Go</button>', viewport: { width: 1280, height: 800 } }
  - { id: B, title: B }
`,
    "t",
  ).flow as Flow;

  it("is the canvas frame's document without the frame script", () => {
    for (const s of flow.screens) {
      // The screens here have no scripts of their own, so the one script in the body is the frame's.
      const frame = screenDocument(flow, s, { channel: "c" }).replace(/<script>[\s\S]*<\/script>(<\/body><\/html>)$/, "$1");
      expect(screenPage(flow, s)).toBe(frame);
    }
  });

  it("marks a prototype section's tags with their prototype.html lines", () => {
    const page = screenPage(flow, { id: "S", title: "S", badges: [], html: '<section data-screen="S">\n<p>x</p></section>', htmlLine: 12 });
    expect(page).toContain('<section data-df-line="12" data-screen="S">\n<p data-df-line="13">x</p></section>');
  });

  it("differs from a prototype section's frame only in where its lines count from", () => {
    const s = { id: "S", title: "S", badges: [], html: '<section data-screen="S">\n<p>x</p>\n<b>y</b></section>', htmlLine: 12 };
    const frame = screenDocument(flow, s, { channel: "c" })
      .replace(/<script>[\s\S]*<\/script>(<\/body><\/html>)$/, "$1")
      .replace(/data-df-line="(\d+)"/g, (_, n) => `data-df-line="${Number(n) + 11}"`);
    expect(screenPage(flow, s)).toBe(frame);
  });
});

const PROTOTYPE = `<!doctype html>
<html><head><style>
body{margin:0;font:16px/1.4 system-ui}section{padding:16px}
.row{display:flex;gap:8px}
.card{flex:0 0 200px;height:60px;background:#ddd}
.title{width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pos{position:relative;height:60px}
.pos span{position:absolute;left:10px;top:10px}
.carousel{display:flex;overflow-x:auto}
.carousel div{flex:0 0 300px}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.4)}
.sheet{position:absolute;left:20px;right:20px;top:20px;background:#fff}
.box{height:20px;overflow:hidden}
.fade{animation:fade 3s forwards;opacity:0}
@keyframes fade{to{opacity:1}}
</style></head>
<body>
<section data-screen="A">
  <div class="wrap"><h1>Pay</h1></div>
  <p>Total <b>$42</b></p>
  <button data-id="pay">Pay now</button>
  <p style="display:none">gone</p><p style="visibility:hidden">hidden</p><p style="opacity:0">clear</p>
  <div style="width:0;height:0"></div><div class="spacer" style="height:40px"></div>
  <div class="box"><p>in view</p><p>cut away below</p></div>
  <p class="fade">faded in</p>
</section>
<section data-screen="B">
  <div class="row"><div class="card">one</div><div class="card">two</div></div>
  <div class="title">A very long product name that will not fit</div>
  <div class="pos"><span>Total</span><span>$42.00</span></div>
  <div class="carousel"><div>scrolls a</div><div>scrolls b</div></div>
</section>
<section data-screen="C">
  <p>List item one</p><p>List item two</p>
  <div class="scrim"><div class="sheet"><p>Delete this note?</p></div></div>
</section>
</body></html>
`;
const FLOW = `version: 1
title: Pay
screens:
  - { id: A, title: Amount }
  - { id: B, title: Broken }
  - { id: C, title: Dialog }
  - id: W
    title: Wide
    viewport: { width: 800, height: 600 }
    html: <main><h1>Desk</h1></main>
edges:
  - { from: A, to: B }
  - { from: B, to: C }
  - { from: C, to: W }
`;

function project(flow = FLOW, prototype = PROTOTYPE) {
  const dir = mkdtempSync(join(tmpdir(), "df-render-"));
  mkdirSync(join(dir, ".design-flow", "pay"), { recursive: true });
  writeFileSync(join(dir, ".design-flow", "pay", "flow.yaml"), flow);
  writeFileSync(join(dir, ".design-flow", "pay", "prototype.html"), prototype);
  return dir;
}

/** The CLI with a temp dir of its own, so shots and browser profiles land where the test can look. */
async function df(args: string[], cwd: string, opts: { bin?: string; temp?: string; env?: Record<string, string> } = {}) {
  const temp = opts.temp ?? mkdtempSync(join(tmpdir(), "df-render-tmp-"));
  const env = { ...process.env, DESIGN_FLOW_HOME: join(temp, "home"), DESIGN_FLOW_PORT: "0", DESIGN_FLOW_LOCALE: "en", TMPDIR: temp, ...opts.env };
  try {
    const r = await run(process.execPath, [opts.bin ?? BIN, ...args], { cwd, env });
    return { code: 0, out: r.stdout, err: r.stderr, temp };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr, temp };
  }
}
const profiles = (temp: string) => readdirSync(temp).filter((n) => n.startsWith("design-flow-chrome-"));

describe("without a browser", () => {
  it("check --visual says how to point at one, and still prints check's own issues", async () => {
    const dir = project(FLOW, PROTOTYPE.replace('<button data-id="pay">', '<button data-id="pay" data-to="Q">'));
    const r = await df(["check", "pay", "--visual"], dir, { env: { DESIGN_FLOW_CHROME: join(dir, "no-such-browser") } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("prototype.html:21:1 data-to in A goes to unknown screen Q");
    expect(r.err).toContain("DESIGN_FLOW_CHROME");
  });
});

describe.skipIf(!browser)("rendering screens in headless Chrome", () => {
  it("holds animations still: a finite one at its end, an endless one at its start", async () => {
    const b = await launchBrowser();
    try {
      const html = `<style>.f{opacity:0;animation:f 9s forwards}@keyframes f{to{opacity:1}}.s{animation:s 1s linear infinite}@keyframes s{to{transform:translateX(90px)}}</style><p class="f">a</p><p class="s">b</p>`;
      const page = await b.open(html, { width: 390, height: 844 }, 1);
      const state = await page.call(() => ({
        fade: getComputedStyle(document.querySelector(".f")!).opacity,
        spin: getComputedStyle(document.querySelector(".s")!).transform,
        states: document.getAnimations().map((a) => a.playState),
      }));
      expect(state).toEqual({ fade: "1", spin: "matrix(1, 0, 0, 1, 0, 0)", states: ["finished", "paused"] });
      await page.close();
    } finally {
      await b.close();
    }
  });

  it("gives boxes in page px, also on a screen that scrolls itself as it loads", async () => {
    const b = await launchBrowser();
    try {
      const html = `<body style="margin:0"><div style="height:1500px"></div><p id="far" style="margin:0;height:20px">Far</p><script>scrollTo(0, 600)</script></body>`;
      const page = await b.open(html, { width: 390, height: 844 }, 1);
      const found = await page.call(findElement, selectorFor, ownText, describeTree, "#far", false);
      if ("error" in found) throw new Error(found.error);
      expect(found.scroll.y).toBe(600);
      expect(found.box.y + found.scroll.y).toBe(1500);
      const tree = await page.call(describeTree, selectorFor, ownText, 60);
      expect(tree.find((n) => n.selector === "#far")!.box).toEqual({ x: 0, y: 1500, width: 390, height: 20 });
      await page.close();
    } finally {
      await b.close();
    }
  });

  it("shot writes a PNG of the screen at its viewport and scale into the temp dir, and leaves no browser behind", async () => {
    const dir = project();
    const r = await df(["shot", "pay", "A"], dir);
    expect(r.code, r.err).toBe(0);
    const file = r.out.trim();
    expect(file).toBe(join(r.temp, "design-flow-shots", "pay", "A.png"));
    expect(pngSize(file)).toEqual({ width: 780, height: 1688 });
    expect(profiles(r.temp)).toEqual([]);
    const wide = await df(["shot", "pay", "W", "--scale", "1", "--out", "out/w.png"], dir);
    expect(pngSize(join(dir, "out", "w.png"))).toEqual({ width: 800, height: 600 });
    // --out is from the directory the command runs in.
    expect(wide.out.trim()).toBe(join(realpathSync(dir), "out", "w.png"));
  });

  it("shot --element clips to the element with 8 px around it; a selector that matches nothing is a usage error", async () => {
    const dir = project();
    const r = await df(["shot", "pay", "A", "--element", '[data-id="pay"]', "--scale", "1"], dir);
    expect(r.code, r.err).toBe(0);
    const outline = JSON.parse((await df(["outline", "pay", "A", "--json"], dir)).out);
    const pay = outline.elements.find((e: { selector: string }) => e.selector === '[data-id="pay"]');
    expect(pngSize(r.out.trim())).toEqual({ width: pay.box.width + 16, height: pay.box.height + 16 });
    const missing = await df(["shot", "pay", "A", "--element", ".nope"], dir);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("nothing on screen A matches --element .nope");
    expect((await df(["shot", "pay", "A", "--scale", "3"], dir)).code).toBe(2);
    expect((await df(["shot", "pay", "Q"], dir)).err).toContain("no screen Q in flow.yaml");
  });

  it("shot --all writes one PNG per screen into --dir", async () => {
    const dir = project();
    const out = join(dir, "shots");
    const r = await df(["shot", "pay", "--all", "--dir", out], dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["A", "B", "C", "W"].map((s) => join(out, `${s}.png`)));
    expect((await df(["shot", "pay", "--all", "--element", "h1"], dir)).code).toBe(2);
  });

  it("outline lists a screen's visible elements with refs, text, boxes, selectors and lines", async () => {
    const dir = project();
    const r = await df(["outline", "pay", "A"], dir);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("Screen A Amount, 390x844; lines are in prototype.html");
    expect(lines[1]).toMatch(/^e1 section 0,0 390x\d+ section line 18$/);
    // The wrapper that holds only the heading gives way to it; display none, visibility hidden, opacity 0, zero size,
    // the empty spacer and what overflow: hidden cuts away are left out.
    expect(lines.slice(2).map((l) => l.trim().replace(/ \d+,\d+ \d+x\d+ /, " … "))).toEqual([
      'e2 h1 "Pay" … section > div:nth-of-type(1) > h1 line 19',
      'e3 p "Total" … section > p:nth-of-type(1) line 20',
      'e4 b "$42" … section > p:nth-of-type(1) > b line 20',
      'e5 button "Pay now" … [data-id="pay"] line 21',
      'e6 p "in view" … section > div:nth-of-type(4) > p:nth-of-type(1) line 24',
      'e7 p "faded in" … section > p:nth-of-type(5) line 25',
    ]);
    expect(lines[3]).toMatch(/^ {2}e3 p /);
    expect(lines[4]).toMatch(/^ {4}e4 b /);
  });

  it("outline of a long screen prints the start and writes the whole tree to a temp file", async () => {
    const items = Array.from({ length: 450 }, (_, i) => `<li>Item ${i + 1}</li>`).join("\n");
    const dir = project(FLOW, PROTOTYPE.replace('<section data-screen="C">', `<section data-screen="C"><ul>${items}</ul>`));
    const r = await df(["outline", "pay", "C"], dir);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(402);
    const file = lines.at(-1)!.match(/The whole outline: (\S+)$/)![1];
    expect(file).toBe(join(r.temp, "design-flow-shots", "pay", "C.outline.txt"));
    expect(readFileSync(file, "utf8")).toContain('"Item 450"');
  });

  it("check --visual reports overflow, cut-off and overlapping text, but not a scroll area or a dialog over the page", async () => {
    const dir = project();
    const r = await df(["check", "pay", "--visual"], dir);
    expect(r.code).toBe(3);
    const issues = r.out.split("\n").filter((l) => !l.startsWith("  → "));
    expect(issues).toEqual([
      '.design-flow/pay/prototype.html:28:1 B section > div:nth-of-type(1) > div:nth-of-type(2) "two": wider than the screen, it ends 34 px past the right edge',
      expect.stringMatching(/^\.design-flow\/pay\/prototype\.html:29:1 B section > div:nth-of-type\(2\) "A very long product name that will not …": text cut off, it needs \d+ px across and shows 120$/),
      '.design-flow/pay/prototype.html:30:1 B section > div:nth-of-type(3) > span:nth-of-type(1) "Total" and section > div:nth-of-type(3) > span:nth-of-type(2) "$42.00": text overlaps text (100% of the smaller)',
      "",
    ]);
    expect(r.out).toContain("  → Give it room, let it wrap, or shorten the copy.");
    const clean = project(FLOW.replace("{ id: B, title: Broken }", "{ id: B, title: Broken, html: <p>fine</p> }"));
    const ok = await df(["check", "pay", "--visual"], clean);
    expect(ok).toMatchObject({ code: 0, out: "pay: clean, 4 screens rendered\n" });
  });

  it("check --visual points at flow.yaml for a screen written there", async () => {
    const dir = project(FLOW.replace("html: <main><h1>Desk</h1></main>", 'html: <main style="width:900px">Desk</main>').replace("{ id: B, title: Broken }", "{ id: B, title: Broken, html: <p>fine</p> }"));
    const r = await df(["check", "pay", "--visual"], dir);
    expect(r.out.split("\n")[0]).toBe('.design-flow/pay/flow.yaml:7:1 W main "Desk": wider than the screen, it ends 100 px past the right edge');
  });

  it("the bundled skill renders the same, from its minified source", async () => {
    const dir = project();
    const r = await df(["outline", "pay", "A", "--json"], dir, { bin: SKILL_BIN });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).elements.map((e: { ref: string; tag: string }) => `${e.ref} ${e.tag}`)).toEqual(["e1 section", "e2 h1", "e3 p", "e4 b", "e5 button", "e6 p", "e7 p"]);
    expect((await df(["check", "pay", "--visual"], dir, { bin: SKILL_BIN })).out).toContain("text overlaps text");
  });

  it.skipIf(process.platform === "win32")("an interrupted render ends the browser and removes its profile", async () => {
    const dir = project();
    const temp = mkdtempSync(join(tmpdir(), "df-render-tmp-"));
    const env = { ...process.env, DESIGN_FLOW_HOME: join(temp, "home"), DESIGN_FLOW_PORT: "0", TMPDIR: temp };
    const child = spawn(process.execPath, [BIN, "shot", "pay", "--all"], { cwd: dir, env, stdio: "ignore" });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    let profile: string | undefined;
    for (let i = 0; i < 200 && !profile; i++) {
      await new Promise((r) => setTimeout(r, 25));
      profile = profiles(temp)[0];
    }
    expect(profile).toBeTruthy();
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(existsSync(join(temp, profile!))).toBe(false);
    const ps = await run("ps", ["-ax", "-o", "command="]);
    expect(ps.stdout).not.toContain(join(temp, profile!));
  });
});

describe.skipIf(!browser)("ask", () => {
  it("anchors the agent's question on an element: selector, text, box, offset, near, line and a point on the canvas", async () => {
    const dir = project();
    const r = await df(["ask", "pay", "A", "--text", "Pay now or later?", "--element", "e5", "--option", "Now", "--option", "Later", "--recommend", "A"], dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Asked #\w{8} on Screen A Amount · button "Pay now" \(\[data-id="pay"\]\) prototype\.html:21\.\n$/);
    const t = JSON.parse(readFileSync(join(dir, ".design-flow", "pay", "comments.json"), "utf8")).threads[0];
    expect(t).toMatchObject({ status: "open", seen: 1, messages: [{ author: "agent", text: "Pay now or later?", options: ["Now", "Later"], recommended: 0 }] });
    expect(t.anchor).toMatchObject({ type: "element", screen: "A", selector: '[data-id="pay"]', tag: "button", text: "Pay now", offset: { x: 0.5, y: 0.5 }, line: 21 });
    expect(t.anchor.near).toContain("Pay now");
    const { box, point } = t.anchor;
    expect(box.width).toBeGreaterThan(0);
    // The screen's frame is 180 px wide on the canvas for its 390 CSS px.
    const { layoutFlow } = await import("../src/core/layout.ts");
    const frame = (await layoutFlow(parseFlow(FLOW, "").flow!)).screens.A;
    const k = frame.w / 390;
    expect(point).toEqual({ x: Math.round(frame.x + (box.x + box.width / 2) * k), y: Math.round(frame.y + (box.y + box.height / 2) * k) });
    const missing = await df(["ask", "pay", "A", "--text", "?", "--element", ".nope"], dir);
    expect(missing.code).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, ".design-flow", "pay", "comments.json"), "utf8")).threads).toHaveLength(1);
  });

  it("keeps the pin of an element below the fold on its screen's frame", async () => {
    const dir = project(FLOW, PROTOTYPE.replace('<p class="fade">', '<p data-id="far" style="margin-top:2000px">Far down</p><p class="fade">'));
    expect((await df(["ask", "pay", "A", "--text", "Keep this?", "--element", '[data-id="far"]'], dir)).code).toBe(0);
    const { box, point } = JSON.parse(readFileSync(join(dir, ".design-flow", "pay", "comments.json"), "utf8")).threads[0].anchor;
    expect(box.y).toBeGreaterThan(2000);
    const { layoutFlow } = await import("../src/core/layout.ts");
    const frame = (await layoutFlow(parseFlow(FLOW, "").flow!)).screens.A;
    expect(point.y).toBe(Math.round(frame.y + 844 * (frame.w / 390)));
  });
});
