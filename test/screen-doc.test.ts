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
