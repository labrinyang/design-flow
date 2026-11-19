import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { FRAME_H, FRAME_W, layoutFlow, type Layout } from "../src/core/layout.ts";

function flowOf(yaml: string): Flow {
  const { flow, issues } = parseFlow(yaml, "t");
  if (!flow) throw new Error(JSON.stringify(issues));
  return flow;
}

function overlaps(l: Layout): string[] {
  const ids = Object.keys(l.screens);
  const bad: string[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = l.screens[ids[i]];
      const b = l.screens[ids[j]];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(`${ids[i]}/${ids[j]}`);
    }
  return bad;
}

const base = `version: 1
title: T
lanes:
  - { id: a, title: A, tone: success }
  - { id: b, title: B, tone: info }
  - { id: x, title: X, tone: danger, enter: any }
screens:
  - { id: H, title: Home }
  - { id: A1, title: A1, lane: a }
  - { id: A2, title: A2, lane: a }
  - { id: A3, title: A3, lane: a }
  - { id: B1, title: B1, lane: b }
  - { id: B2a, title: B2a, lane: b }
  - { id: B2b, title: B2b, lane: b }
  - { id: X1, title: X1, lane: x }
  - { id: X2, title: X2, lane: x }
edges:
  - { from: H, to: A1 }
  - { from: A1, to: A2 }
  - { from: A2, to: A3 }
  - { from: A3, to: H, kind: back }
  - { from: H, to: B1 }
  - { from: B1, to: B2a }
  - { from: B1, to: B2b }
  - { from: X1, to: H, kind: back }
`;

describe("layoutFlow", () => {
  it("assigns columns along the flow, entry in column 0", async () => {
    const l = await layoutFlow(flowOf(base));
    expect([l.screens.H.col, l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([0, 1, 2, 3]);
    expect(l.screens.A1.x).toBeLessThan(l.screens.A2.x);
  });

  it("stacks branches of one lane in one column without overlap", async () => {
    const l = await layoutFlow(flowOf(base));
    expect(l.screens.B2a.col).toBe(l.screens.B2b.col);
    expect(l.screens.B2a.x).toBe(l.screens.B2b.x);
    expect(overlaps(l)).toEqual([]);
  });

  it("places lanes as rows in declared order and screens inside their lane", async () => {
    const l = await layoutFlow(flowOf(base));
    const [a, b, x] = l.lanes;
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(b.y + b.height).toBeLessThanOrEqual(x.y);
    for (const [id, lane] of [["A1", a], ["B2b", b], ["X2", x]] as const) {
      const s = l.screens[id];
      expect(s.y).toBeGreaterThanOrEqual(lane.y);
      expect(s.y + s.h).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it("centres the lane-less entry vertically across the lanes", async () => {
    const l = await layoutFlow(flowOf(base));
    const top = l.lanes[0].y;
    const bottom = l.lanes.at(-1)!.y + l.lanes.at(-1)!.height;
    const mid = l.screens.H.y + l.screens.H.h / 2;
    expect(Math.abs(mid - (top + bottom) / 2)).toBeLessThan(2);
  });

  it("tiles an enter:any lane from column 1 in screen order", async () => {
    const l = await layoutFlow(flowOf(base));
    expect([l.screens.X1.col, l.screens.X2.col]).toEqual([1, 2]);
    expect(l.screens.X1.y).toBe(l.screens.X2.y);
  });

  it("keeps an overridden position and lays out the rest", async () => {
    const l = await layoutFlow(flowOf(base), { A2: { x: 5000, y: 40 } });
    expect(l.screens.A2).toMatchObject({ x: 5000, y: 40, pinned: true });
    expect(l.screens.A1.pinned).toBe(false);
    expect(l.width).toBeGreaterThanOrEqual(5000 + FRAME_W);
  });

  it("ignores overrides for screens that no longer exist", async () => {
    const l = await layoutFlow(flowOf(base), { GONE: { x: 1, y: 1 } });
    expect(l.screens.GONE).toBeUndefined();
  });

  it("handles a lane with no screens", async () => {
    const text = base.replace("lanes:\n", "lanes:\n  - { id: empty, title: E }\n");
    const l = await layoutFlow(flowOf(text));
    expect(l.lanes[0].id).toBe("empty");
    expect(l.lanes[0].height).toBeGreaterThan(0);
    expect(overlaps(l)).toEqual([]);
  });
});

describe("layoutFlow lane bounds", () => {
  it("keeps every lane screen right of the entry column", async () => {
    const f = flowOf(`version: 1
title: T
lanes:
  - { id: m, title: M }
  - { id: x, title: X, enter: any }
screens:
  - { id: H, title: H }
  - { id: M1, title: M1, lane: m }
  - { id: X1, title: X1, lane: x }
edges:
  - { from: H, to: M1 }
  - { from: X1, to: H, kind: back }
`);
    const l = await layoutFlow(f);
    expect(l.screens.M1.col).toBe(1);
    expect(l.screens.M1.x).toBeGreaterThanOrEqual(l.screens.H.x + FRAME_W + 40);
  });

  it("starts lanes below the canvas top with room for the lane title", async () => {
    const l = await layoutFlow(flowOf(base));
    expect(l.lanes[0].y).toBeGreaterThanOrEqual(24);
  });
});

describe("layoutFlow cycles", () => {
  it("keeps the flow left to right when a normal edge returns home", async () => {
    const text = base.replace("  - { from: A3, to: H, kind: back }\n", "  - { from: A3, to: H, label: Done }\n  - { from: B2a, to: H, label: Done }\n");
    const l = await layoutFlow(flowOf(text));
    expect([l.screens.H.col, l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([0, 1, 2, 3]);
    expect([l.screens.B1.col, l.screens.B2a.col]).toEqual([1, 2]);
  });

  it("orders a cycle between lane screens from where the flow enters it", async () => {
    const text = base.replace("  - { from: A3, to: H, kind: back }\n", "  - { from: A3, to: A1, label: Again }\n");
    const l = await layoutFlow(flowOf(text));
    expect([l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([1, 2, 3]);
  });
});
