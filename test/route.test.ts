import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { toReactFlow } from "../web/src/model.ts";
import { roundedPath, routeEdges, simplify, type Point, type Rect, type RouteEdge, type RouteInput, type RouteScreen, type Zone } from "../web/src/route.ts";

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

/**
 * A board shaped like the largest real one, built the way model.ts builds route input: 26 lanes that start further
 * right as the flow goes on, 186 frames (mostly 480x285, some tall ones) in stacks of up to 8, 312 edges, nearly
 * all labelled, with ways back and edges within a column, lane titles and notes, channels, zones and borders.
 */
function bigBoard(): RouteInput {
  let seed = 20261126;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (n: number) => Math.floor(rand() * n);
  const [COL, GAP, PAD, LANE_X] = [600, 24, 32, 530];
  const screens: RouteScreen[] = [];
  const add = (id: string, x: number, y: number, [w, h]: number[]) =>
    screens.push({ id, frame: { x0: x, y0: y, x1: x + w, y1: y + h }, block: { x0: x, y0: y - 46, x1: x + w, y1: y + h + (pick(7) ? 0 : 44) } });
  const counts = Array.from({ length: 26 }, () => 2 + pick(11));
  const total = () => counts.reduce((a, b) => a + b);
  for (let i = 0; total() !== 185; i++) counts[i % 26] += total() < 185 ? 1 : counts[i % 26] > 2 ? -1 : 0;
  const lanes: { y: number; h: number; ids: string[][] }[] = [];
  const obstacles: Rect[] = [];
  let y = 40;
  counts.forEach((n, l) => {
    const stacks = Array.from({ length: Math.min(n, Math.max(Math.ceil(n / 8), 1 + pick(8))) }, () => 1);
    for (let k = stacks.length; k < n; k++) {
      let c = pick(stacks.length);
      while (stacks[c] === 8) c = (c + 1) % stacks.length;
      stacks[c]++;
    }
    const sizes = stacks.map((k) => Array.from({ length: k }, () => (pick(5) ? [480, 285] : pick(2) ? [252, 640] : [429, 640])));
    const tall = (col: number[][]) => col.reduce((t, [, h]) => t + 46 + h + 44, 0) + (col.length - 1) * GAP;
    const inner = Math.max(...sizes.map(tall));
    const h = inner + 2 * PAD;
    const c0 = 1 + Math.floor(l * 1.4);
    const ids = sizes.map((col, c) => {
      let sy = y + PAD + (inner - tall(col)) / 2;
      return col.map((size, r) => {
        const id = `s${l}-${c}-${r}`;
        add(id, 40 + (c0 + c) * COL, sy + 46, size);
        sy += 46 + size[1] + 44 + GAP;
        return id;
      });
    });
    obstacles.push({ x0: LANE_X + 24, y0: y - 14, x1: LANE_X + 24 + 20 + (6 + pick(24)) * 18 * 0.58 + (pick(5) ? 0 : 12 + 9 * 12 * 0.54), y1: y + 14 });
    if (!pick(4)) obstacles.push({ x0: LANE_X + 24, y0: y + h - 32, x1: LANE_X + 24 + (10 + pick(50)) * 13 * 0.54, y1: y + h - 12 });
    lanes.push({ y, h, ids });
    y += h + 56;
  });
  add("entry", 40, (40 + y - 56) / 2 - 142.5, [480, 285]);
  const label = () => (pick(30) ? { w: (4 + pick(24)) * 13 * 0.58 * 1.06 + 12, h: 22 } : undefined);
  const edges: RouteEdge[] = [];
  const one = <T>(list: T[]) => list[pick(list.length)];
  lanes.forEach(({ ids }, l) => {
    for (let c = 0; c + 1 < ids.length; c++) edges.push({ from: one(ids[c]), to: one(ids[c + 1]), label: label() });
    for (const col of ids) if (col.length > 1 && pick(2)) edges.push({ from: col[0], to: col[1 + pick(col.length - 1)], label: label() });
    const next = lanes[l + 1];
    if (next) edges.push({ from: one(ids[ids.length - 1]), to: one(next.ids[0]), label: label() });
  });
  for (let l = 0; l < 3; l++) edges.push({ from: "entry", to: lanes[l].ids[0][0], label: label() });
  while (edges.length < 310) {
    const kind = pick(10);
    const { ids } = lanes[pick(lanes.length)];
    const a = one(ids);
    const b = one(ids);
    if (kind < 3) edges.push({ from: one(a), to: one(b), label: label() });
    else if (kind < 5) edges.push({ from: one(b), to: one(a), label: label(), back: true });
    else if (kind < 6 && a.length > 1) edges.push({ from: a[a.length - 1], to: a[0], label: label(), back: true });
    else {
      const other = lanes[pick(lanes.length)].ids;
      edges.push({ from: one(a), to: one(one(other)), label: label(), back: !pick(4) });
    }
  }
  edges.push({ from: "s3-0-0", to: "s3-0-0", label: label() }, { from: "s4-0-0", to: "missing", label: label() });
  const width = Math.max(...screens.map((s) => s.frame.x1)) + 40;
  return {
    screens,
    edges,
    obstacles,
    channels: lanes.flatMap((l) => [l.y + PAD / 2, l.y + l.h - PAD / 2]),
    zones: lanes.flatMap((l): Zone[] => [
      { y0: l.y, y1: l.y + l.h / 2, prefer: "forward" },
      { y0: l.y + l.h / 2, y1: l.y + l.h, prefer: "back" },
    ]),
    borders: { x: [LANE_X, width], y: lanes.flatMap((l) => [l.y, l.y + l.h]) },
  };
}

describe("a board the size of the largest real one", () => {
  it("routes exactly as it did before routing got faster", () => {
    const routes = routeEdges(bigBoard());
    expect(routes.filter(Boolean)).toHaveLength(311);
    // SHA-256 of the output recorded with the slower code; any change to the lines or labels changes it. When one is
    // meant, record the new hash and bump VERSION in web/src/route-cache.ts, so browsers drop the routes they kept.
    expect(createHash("sha256").update(JSON.stringify(routes)).digest("hex")).toBe("a5b62564db160269b4e6dd652bcd1aa5f6dfbe2425def9629a82f0c637ecf515");
  });
});
