import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { markOf, placeDraft } from "../web/src/draft.ts";

const flow = parseFlow(
  `version: 1
title: T
lanes: [{ id: a, title: A }]
screens:
  - { id: S1, title: One, lane: a }
  - { id: S2, title: Two, lane: a }
edges:
  - { from: S1, to: S2, label: first }
  - { from: S1, to: S2, label: second }
`,
  "t",
).flow as Flow;

describe("placeDraft", () => {
  const box = { width: 300, height: 170 };
  const room = { width: 1200, height: 800 };

  it("puts the box just right of its marker, its top a little above it", () => {
    expect(placeDraft({ x: 400, y: 300 }, box, room)).toEqual({ left: 416, top: 280 });
  });
  it("flips to the marker's left when there is no room on the right", () => {
    expect(placeDraft({ x: 1000, y: 300 }, box, room)).toEqual({ left: 684, top: 280 });
  });
  it("stays inside the room vertically", () => {
    expect(placeDraft({ x: 400, y: 780 }, box, room).top).toBe(800 - 170 - 12);
    expect(placeDraft({ x: 400, y: 0 }, box, room).top).toBe(12);
  });
  it("keeps above the floating toolbar at the bottom", () => {
    // 80px of the room's bottom belong to the toolbar.
    expect(placeDraft({ x: 400, y: 700 }, box, room, 80).top).toBe(800 - 80 - 170 - 12);
  });
});

describe("markOf", () => {
  it("marks the element inside its screen", () => {
    expect(markOf({ type: "element", screen: "S2", selector: '[data-id="go"]', tag: "button", text: "Go", point: { x: 0, y: 0 } }, flow)).toEqual({
      screen: "S2",
      selector: '[data-id="go"]',
    });
  });
  it("marks the exact edge, telling parallel edges apart by index", () => {
    expect(markOf({ type: "edge", edge: { from: "S1", to: "S2", index: 1 }, point: { x: 0, y: 0 } }, flow)).toEqual({ edge: "S1->S2#1" });
    expect(markOf({ type: "edge", edge: { from: "S1", to: "S2" }, point: { x: 0, y: 0 } }, flow)).toEqual({ edge: "S1->S2" });
  });
  it("marks a whole screen or lane, and only the point on empty canvas", () => {
    expect(markOf({ type: "screen", screen: "S1", point: { x: 0, y: 0 } }, flow)).toEqual({ screen: "S1" });
    expect(markOf({ type: "lane", lane: "a", point: { x: 0, y: 0 } }, flow)).toEqual({ lane: "a" });
    expect(markOf({ type: "canvas", point: { x: 0, y: 0 } }, flow)).toEqual({});
  });
});
