import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { readFileSync } from "node:fs";
import { toReactFlow } from "../web/src/model.ts";
import { roundedPath, routeEdges, simplify, type Point, type Rect, type RouteScreen } from "../web/src/route.ts";

const box = (id: string, x: number, y: number, w = 180, h = 390): RouteScreen => ({
  id,
  frame: { x0: x, y0: y, x1: x + w, y1: y + h },
  block: { x0: x, y0: y - 46, x1: x + w, y1: y + h + 44 },
});

const inside = (p: Point, q: Point, r: Rect) =>
  p.x === q.x
    ? p.x > r.x0 && p.x < r.x1 && Math.max(p.y, q.y) > r.y0 && Math.min(p.y, q.y) < r.y1
    : p.y > r.y0 && p.y < r.y1 && Math.max(p.x, q.x) > r.x0 && Math.min(p.x, q.x) < r.x1;

/** Every stretch of every line, except the first and last few pixels at its own frames. */
function stretches(points: Point[]) {
  const out: [Point, Point][] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1]]);
  return out;
}

/** Length two lines run along the same stretch. */
function shared(a: Point[], b: Point[]): number {
  let total = 0;
  for (const [p, q] of stretches(a))
    for (const [r, s] of stretches(b)) {
      if (p.x === q.x && r.x === s.x && p.x === r.x)
        total += Math.max(0, Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)));
      if (p.y === q.y && r.y === s.y && p.y === r.y)
        total += Math.max(0, Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)));
    }
  return total;
}

const labelBox = (p: Point, w: number, h: number): Rect => ({ x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 });
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

describe("routeEdges", () => {
  it("draws one level line between neighbours in a row, label in the middle", () => {
    const [r] = routeEdges({ screens: [box("A", 0, 0), box("B", 300, 0)], edges: [{ from: "A", to: "B", label: { w: 60, h: 20 } }] });
    expect(r!.points).toEqual([
      { x: 180, y: 195 },
      { x: 300, y: 195 },
    ]);
    expect(r!.label).toEqual({ x: 240, y: 195 });
    expect(r!.sides).toEqual(["right", "left"]);
  });

  it("takes a forward edge over the screens it skips, and a way back under them", () => {
    const screens = [box("A", 0, 0), box("B", 300, 0), box("C", 600, 0)];
    const lane = { x0: -40, y0: -46 - 32, x1: 820, y1: 390 + 44 + 32 };
    const [skip, back] = routeEdges({
      screens,
      edges: [
        { from: "A", to: "C" },
        { from: "C", to: "A", back: true },
      ],
      channels: [lane.y0 + 16, lane.y1 - 16],
      zones: [
        { y0: lane.y0, y1: 195, prefer: "forward" },
        { y0: 195, y1: lane.y1, prefer: "back" },
      ],
      borders: { x: [lane.x0, lane.x1], y: [lane.y0, lane.y1] },
    });
    for (const [p, q] of stretches(skip!.points)) expect(inside(p, q, screens[1].block)).toBe(false);
    for (const [p, q] of stretches(back!.points)) expect(inside(p, q, screens[1].block)).toBe(false);
    expect(Math.min(...skip!.points.map((p) => p.y))).toBeLessThan(screens[1].block.y0);
    expect(Math.max(...back!.points.map((p) => p.y))).toBeGreaterThan(screens[1].block.y1);
    expect(back!.sides).toEqual(["left", "right"]);
  });

  it("goes round the outside for screens in one column", () => {
    const screens = [box("A", 0, 0), box("B", 0, 600)];
    const [down, up] = routeEdges({ screens, edges: [{ from: "A", to: "B" }, { from: "B", to: "A" }] });
    expect(down!.sides).toEqual(["right", "right"]);
    expect(shared(down!.points, up!.points)).toBe(0);
  });

  it("keeps two edges between the same screens on separate lines", () => {
    const [a, b] = routeEdges({ screens: [box("A", 0, 0), box("B", 300, 0)], edges: [{ from: "A", to: "B" }, { from: "A", to: "B" }] });
    expect(shared(a!.points, b!.points)).toBe(0);
  });

  it("never puts stubs that face each other across a gap at the same height", () => {
    // B's right side has two line ends, C's left side one; both turn off into the gap between them.
    const screens = [box("A", 0, 0), box("B", 300, 0), box("C", 600, 0), box("D", 300, 600), box("E", 600, -600)];
    const routes = routeEdges({
      screens,
      edges: [
        { from: "B", to: "E" },
        { from: "D", to: "B" },
        { from: "A", to: "C" },
      ],
    });
    const bRight = routes.flatMap((r) => r!.points.filter((p) => p.x === 480));
    const cLeft = routes.flatMap((r) => r!.points.filter((p) => p.x === 600));
    for (const p of bRight) for (const q of cLeft) expect(p.y).not.toBe(q.y);
  });

  it("gives up on an edge whose ends are boxed in, instead of drawing through a frame", () => {
    const screens = [box("A", 0, 0), box("B", 185, 0), box("C", 400, 0)];
    const [r] = routeEdges({ screens, edges: [{ from: "A", to: "C" }] });
    // A's right side touches B: no room to leave it.
    expect(r).toBeUndefined();
  });
});

describe("the example flow", async () => {
  const text = readFileSync(new URL("../examples/notely/.design-flow/sign-up/flow.yaml", import.meta.url), "utf8");
  const flow = parseFlow(text, "x").flow as Flow;
  const layout = await layoutFlow(flow);
  const { edges } = toReactFlow(flow, layout);
  const blocks = flow.screens.map((s) => {
    const b = layout.screens[s.id];
    return { id: s.id, r: { x0: b.x, y0: b.y - 46, x1: b.x + b.w, y1: b.y + b.h + (s.note ? 44 : 0) } };
  });
  const routes = routeEdges({
    screens: flow.screens.map((s) => {
      const b = layout.screens[s.id];
      return { id: s.id, frame: { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }, block: blocks.find((x) => x.id === s.id)!.r };
    }),
    edges: flow.edges.map((e) => ({ from: e.from, to: e.to, back: e.kind === "back", label: e.label ? { w: e.label.length * 7.5 + 12, h: 22 } : undefined })),
  });

  it("routes every edge", () => {
    expect(edges.every((e) => e.data?.route)).toBe(true);
    expect(routes.every(Boolean)).toBe(true);
  });

  it("never draws a line behind a frame, title or note", () => {
    for (const r of routes)
      for (const [p, q] of stretches(r!.points))
        for (const b of blocks) {
          // A line may only touch its own frames, at its ends.
          const ends = [r!.points[0], r!.points.at(-1)!];
          const own = ends.some((e) => e.x >= b.r.x0 && e.x <= b.r.x1 && e.y >= b.r.y0 && e.y <= b.r.y1);
          if (!own) expect(inside(p, q, b.r), `${JSON.stringify([p, q])} crosses ${b.id}`).toBe(false);
        }
  });

  it("keeps lines apart", () => {
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++) expect(shared(routes[i]!.points, routes[j]!.points), `${i} and ${j}`).toBe(0);
  });

  it("keeps labels off frames and off each other", () => {
    const placed = flow.edges.flatMap((e, i) => (e.label ? [{ i, r: labelBox(routes[i]!.label!, e.label.length * 7.5 + 12, 22) }] : []));
    for (const a of placed) {
      // A label wider than the gap between two neighbours has nowhere else to go on their one straight line.
      const pts = routes[a.i]!.points;
      const squeezed = pts.length === 2 && Math.abs(pts[1].x - pts[0].x) < a.r.x1 - a.r.x0;
      if (!squeezed) for (const b of blocks) expect(overlapArea(a.r, b.r), `label ${a.i} on ${b.id}`).toBe(0);
      for (const b of placed) if (a !== b) expect(overlapArea(a.r, b.r), `labels ${a.i} and ${b.i}`).toBe(0);
    }
  });

  it("separates the two labels that used to sit on top of each other", () => {
    const apple = flow.edges.findIndex((e) => e.label === "Continue with Apple");
    const code = flow.edges.findIndex((e) => e.label === "Code correct");
    expect(overlapArea(labelBox(routes[apple]!.label!, 150, 22), labelBox(routes[code]!.label!, 100, 22))).toBe(0);
  });
});

describe("path helpers", () => {
  it("drops points in the middle of a straight stretch", () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("rounds corners", () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
      ]),
    ).toBe("M0,0L14,0Q20,0 20,6L20,20");
  });
});
