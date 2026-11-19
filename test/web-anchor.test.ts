import { describe, expect, it } from "vitest";
import { anchorFromFrame, anchorFromTarget, exportBounds, nearestScreen } from "../web/src/anchor.ts";

const el = (attrs: Record<string, string>, parent?: FakeEl): FakeEl => ({ attrs, parent });
interface FakeEl {
  attrs: Record<string, string>;
  parent?: FakeEl;
}
const view = (e: FakeEl) => ({
  closest(sel: string) {
    let cur: FakeEl | undefined = e;
    while (cur) {
      if (sel === "[data-anchor]" && cur.attrs["data-anchor"]) return view(cur);
      cur = cur.parent;
    }
    return null;
  },
  getAttribute: (k: string) => e.attrs[k] ?? null,
});

const screens = { A: { x: 0, y: 0 }, B: { x: 600, y: 0 } };
const pt = { x: 650, y: 10 };

describe("anchorFromTarget", () => {
  it("turns a commenting click inside a frame into an element anchor at flow coordinates", () => {
    const a = anchorFromFrame(
      { screen: "B", x: 195, y: 100, element: { selector: '[data-id="pay"]', tag: "button", text: "Pay" } },
      { x: 600, y: 40, w: 180 },
      390,
    );
    expect(a).toEqual({ type: "element", screen: "B", selector: '[data-id="pay"]', tag: "button", text: "Pay", point: { x: 690, y: 86 } });
    expect(anchorFromFrame({ screen: "B", x: 0, y: 0, element: null }, { x: 600, y: 40, w: 180 }, 390)).toEqual({ type: "screen", screen: "B", point: { x: 600, y: 40 } });
  });

  it("recognises screens, edges and lanes", () => {
    expect(anchorFromTarget(view(el({ "data-anchor": "screen", "data-screen": "A" })), pt, screens)).toEqual({ type: "screen", screen: "A", point: pt });
    expect(anchorFromTarget(view(el({ "data-anchor": "edge", "data-from": "A", "data-to": "B" })), pt, screens)).toEqual({
      type: "edge",
      edge: { from: "A", to: "B" },
      point: pt,
    });
    expect(anchorFromTarget(view(el({ "data-anchor": "lane", "data-lane": "x" })), pt, screens)).toEqual({ type: "lane", lane: "x", point: pt });
  });

  it("falls back to the canvas, naming the nearest screen", () => {
    expect(anchorFromTarget(view(el({})), pt, screens)).toEqual({ type: "canvas", point: pt, near: "B" });
    expect(anchorFromTarget(null, pt, {})).toEqual({ type: "canvas", point: pt });
  });

  it("measures nearest screens by frame centre", () => {
    expect(nearestScreen({ x: 100, y: 100 }, screens)).toBe("A");
  });
});

describe("exportBounds", () => {
  it("covers every node with padding", () => {
    const b = exportBounds([
      { x: 10, y: 20, width: 100, height: 50 },
      { x: 500, y: -40, width: 180, height: 360 },
    ], 40);
    expect(b).toEqual({ x: -30, y: -80, width: 750, height: 440 });
  });
});
