import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { FRAME_W, frameSize } from "../src/core/layout.ts";
import { screenDocument, selectorFor } from "../web/src/screen-doc.ts";

const flow = parseFlow(
  `version: 1
title: T
style: <style>.btn{background:tomato}</style>
viewport: { width: 390, height: 844 }
screens:
  - { id: A, title: A, html: '<button class="btn">Go</button>' }
  - { id: B, title: B, html: '<p>wide</p>', viewport: { width: 1280, height: 800 } }
  - { id: C, title: C }
`,
  "t",
).flow as Flow;

describe("screenDocument", () => {
  it("wraps the agent's html with its shared style and a locked-down CSP", () => {
    const doc = screenDocument(flow, flow.screens[0], { channel: "abc" });
    expect(doc).toContain('<button class="btn">Go</button>');
    expect(doc).toContain(".btn{background:tomato}");
    expect(doc).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'/);
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain('"abc"');
    expect(doc).toContain('<meta name="viewport" content="width=390">');
  });

  it("uses the screen's own viewport over the flow's", () => {
    expect(screenDocument(flow, flow.screens[1], { channel: "x" })).toContain("width=1280");
  });

  it("shows a placeholder for a screen without html", () => {
    expect(screenDocument(flow, flow.screens[2], { channel: "x" })).toContain("data-empty");
  });
});

describe("frameSize", () => {
  it("keeps the frame width and follows the viewport's aspect ratio", () => {
    expect(frameSize(flow, flow.screens[0])).toEqual({ width: FRAME_W, height: Math.round((FRAME_W * 844) / 390) });
    expect(frameSize(flow, flow.screens[1]).width).toBeGreaterThan(FRAME_W);
  });
});

describe("selectorFor", () => {
  it("runs from its own source alone, as it does inside a frame after minification", () => {
    // The frame script embeds selectorFor.toString(); any outer helper it calls is renamed by the minifier and missing there.
    const standalone = new Function(`return (${selectorFor.toString()})`)() as typeof selectorFor;
    const body: any = { localName: "body", children: [], parentElement: null, getAttribute: () => null, id: "" };
    const btn: any = { localName: "button", children: [], parentElement: body, getAttribute: (k: string) => (k === "data-id" ? 'say "hi"' : null), id: "" };
    body.children.push(btn);
    expect(standalone(btn, body)).toBe('[data-id="say \\"hi\\""]');
  });

  const doc = new (class {
    body: any;
  })();
  const mk = (tag: string, attrs: Record<string, string> = {}, parent?: any): any => {
    const el: any = {
      tagName: tag.toUpperCase(),
      localName: tag,
      parentElement: parent ?? null,
      children: [] as any[],
      getAttribute: (k: string) => attrs[k] ?? null,
      id: attrs.id ?? "",
    };
    if (parent) parent.children.push(el);
    return el;
  };
  const body = mk("body");
  doc.body = body;
  const main = mk("main", {}, body);
  const b1 = mk("button", {}, main);
  const b2 = mk("button", {}, main);
  const tagged = mk("button", { "data-id": "pay" }, main);
  const withId = mk("input", { id: "amount" }, main);

  it("prefers data-id, then id", () => {
    expect(selectorFor(tagged, body)).toBe('[data-id="pay"]');
    expect(selectorFor(withId, body)).toBe("#amount");
  });

  it("falls back to an nth-of-type path from body", () => {
    expect(selectorFor(b2, body)).toBe("main > button:nth-of-type(2)");
    expect(selectorFor(b1, body)).toBe("main > button:nth-of-type(1)");
  });
});

describe("frame snapshot", () => {
  it("answers snapshot requests with its own markup", () => {
    const doc = screenDocument(flow, flow.screens[0], { channel: "abc" });
    expect(doc).toContain('e.data.type==="snapshot"');
    expect(doc).toContain("XMLSerializer");
  });
});

import { acceptFrameMessage } from "../web/src/screen-doc.ts";
describe("acceptFrameMessage", () => {
  const win = {} as unknown as MessageEventSource;
  const frames = new Map([["ch1", { screen: "P02", window: () => win }]]);
  const click = { channel: "ch1", type: "click", commenting: true, x: 1, y: 2, element: null };
  it("accepts a click from the registered frame's own window", () => {
    expect(acceptFrameMessage({ data: click, source: win }, frames)).toEqual({ screen: "P02", x: 1, y: 2, element: null });
  });
  it("rejects a message whose source is not that frame, or not commenting", () => {
    expect(acceptFrameMessage({ data: click, source: {} as MessageEventSource }, frames)).toBeUndefined();
    expect(acceptFrameMessage({ data: { ...click, commenting: false }, source: win }, frames)).toBeUndefined();
    expect(acceptFrameMessage({ data: { ...click, channel: "other" }, source: win }, frames)).toBeUndefined();
  });
});

import { acceptFrameWheel, frameToClient, scrollsInside } from "../web/src/screen-doc.ts";
describe("frame wheel", () => {
  it("hands wheels to the canvas unless the screen itself can scroll that way", () => {
    const doc = screenDocument(flow, flow.screens[0], { channel: "abc" });
    expect(doc).toContain('addEventListener("wheel"');
    expect(doc).toContain("{passive:false}");
    expect(doc).toContain('type:"wheel"');
    expect(doc).toContain("var scrollsInside=");
  });

  // A frame 844px tall; "box" stands for any element, "list" for a scroll area inside the page.
  type Box = { nodeType: number; parentElement: Box | null; scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number; overflowX: string; overflowY: string };
  const box = (parent: Box | null, o: Partial<Box> = {}): Box => ({ nodeType: 1, parentElement: parent, scrollTop: 0, scrollLeft: 0, scrollHeight: 100, scrollWidth: 390, clientHeight: 100, clientWidth: 390, overflowX: "visible", overflowY: "visible", ...o });
  const page = (pageHeight: number, o: { html?: Partial<Box>; body?: Partial<Box>; list?: Partial<Box> } = {}) => {
    const html = box(null, { scrollHeight: pageHeight, clientHeight: 844, ...o.html });
    const body = box(html, o.body);
    const list = box(body, { overflowY: "auto", scrollHeight: 600, clientHeight: 300, ...o.list });
    const button = box(list);
    return { doc: { scrollingElement: html, documentElement: html, body }, button, html };
  };
  // Runs from its own source alone, as it does inside a frame after minification.
  const run = new Function(`return (${scrollsInside.toString()})`)() as typeof scrollsInside;
  const style = (b: object) => b as Box;

  it("scrolls a page longer than its frame, but only while there is room left that way", () => {
    const long = page(1800, { list: { scrollHeight: 300 } });
    expect(run(long.button, 0, 100, long.doc, style)).toBe(true);
    expect(run(long.button, 0, -100, long.doc, style)).toBe(false);
    long.html.scrollTop = 1800 - 844;
    expect(run(long.button, 0, 100, long.doc, style)).toBe(false);
    expect(run(long.button, 0, -100, long.doc, style)).toBe(true);
  });

  it("scrolls a scroll area under the pointer before handing the wheel on", () => {
    const fits = page(844);
    expect(run(fits.button, 0, 100, fits.doc, style)).toBe(true);
    const atEnd = page(844, { list: { scrollTop: 300 } });
    expect(run(atEnd.button, 0, 100, atEnd.doc, style)).toBe(false);
    expect(run(atEnd.button, 0, -100, atEnd.doc, style)).toBe(true);
  });

  it("does not count a page whose overflow is hidden, on html or on body", () => {
    const viaHtml = page(1800, { html: { overflowY: "hidden" }, list: { scrollHeight: 300 } });
    expect(run(viaHtml.button, 0, 100, viaHtml.doc, style)).toBe(false);
    const viaBody = page(1800, { body: { overflowY: "hidden" }, list: { scrollHeight: 300 } });
    expect(run(viaBody.button, 0, 100, viaBody.doc, style)).toBe(false);
  });

  const win = {} as unknown as MessageEventSource;
  const frames = new Map([["ch1", { screen: "P02", window: () => win }]]);
  const wheel = { channel: "ch1", type: "wheel", x: 10, y: 20, dx: 0, dy: -100, mode: 0, ctrl: true, meta: false, shift: false, alt: false };
  it("accepts a wheel from the registered frame's own window, with its modifier keys", () => {
    expect(acceptFrameWheel({ data: wheel, source: win }, frames)).toEqual({
      channel: "ch1",
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(acceptFrameWheel({ data: { ...wheel, ctrl: false, meta: true }, source: win }, frames)).toMatchObject({ ctrlKey: false, metaKey: true });
  });
  it("rejects a wheel from another window, an unknown frame, or with numbers missing", () => {
    expect(acceptFrameWheel({ data: wheel, source: {} as MessageEventSource }, frames)).toBeUndefined();
    expect(acceptFrameWheel({ data: { ...wheel, channel: "other" }, source: win }, frames)).toBeUndefined();
    expect(acceptFrameWheel({ data: { ...wheel, dy: Number.NaN }, source: win }, frames)).toBeUndefined();
    expect(acceptFrameWheel({ data: { ...wheel, x: "10" }, source: win }, frames)).toBeUndefined();
    expect(acceptFrameWheel({ data: { ...wheel, type: "click" }, source: win }, frames)).toBeUndefined();
  });
  it("finds the same spot on the page from the frame's on-screen box", () => {
    // A 390px-wide frame drawn 195px wide at (100, 50): frame px (200, 400) is page px (200, 250).
    expect(frameToClient({ x: 200, y: 400 }, { left: 100, top: 50, width: 195 }, 390)).toEqual({ x: 200, y: 250 });
  });
});

import { snapshotSvg } from "../web/src/screen-doc.ts";
describe("snapshotSvg", () => {
  it("pins the cloned document to the frame's viewport size", () => {
    const svg = snapshotSvg('<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>x</p></body></html>', 390, 844);
    expect(svg).toContain('width="390" height="844"');
    expect(svg).toMatch(/<html[^>]*style="[^"]*width:\s*390px;[^"]*height:\s*844px/);
  });
});

import { snapshotImageStyle } from "../web/src/screen-doc.ts";
describe("snapshotImageStyle", () => {
  it("keeps the frame's size and transform, and opts out of max-width/height:auto", () => {
    const s = snapshotImageStyle("width: 390px; height: 844px; transform: scale(0.46);", 390, 844);
    expect(s).toContain("max-width: none");
    expect(s).toContain("height: 844px");
    expect(s).toContain("width: 390px");
    expect(s).toContain("transform: scale(0.46)");
  });
});
