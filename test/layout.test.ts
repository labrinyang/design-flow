import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { FRAME_H, FRAME_W, LANE_X, layoutFlow, NOTE_H, type Layout } from "../src/core/layout.ts";

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
  it("lays each lane out from its own start, along its own edges", async () => {
    const l = await layoutFlow(flowOf(base));
    expect([l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([0, 1, 2]);
    expect(l.screens.A1.x).toBeLessThan(l.screens.A2.x);
    // Every lane starts at the same place, whatever leads into it.
    expect(l.screens.B1.x).toBe(l.screens.A1.x);
    expect(l.screens.X1.x).toBe(l.screens.A1.x);
  });

  it("wraps a step of more than three screens into the next column", async () => {
    const more = ["B2c", "B2d", "B2e"];
    const text = base
      .replace("  - { id: B2b, title: B2b, lane: b }\n", `  - { id: B2b, title: B2b, lane: b }\n${more.map((id) => `  - { id: ${id}, title: ${id}, lane: b }\n`).join("")}`)
      .replace("  - { from: B1, to: B2b }\n", `  - { from: B1, to: B2b }\n${more.map((id) => `  - { from: B1, to: ${id} }\n`).join("")}`);
    const l = await layoutFlow(flowOf(text));
    expect(["B1", "B2a", "B2b", ...more].map((id) => l.screens[id].col)).toEqual([0, 1, 1, 1, 2, 2]);
    expect(overlaps(l)).toEqual([]);
    const lane = l.lanes.find((x) => x.id === "b")!;
    expect(lane.height).toBeLessThan(4 * (FRAME_H + 90));
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

  it("puts lane-less screens in a row above the lanes", async () => {
    const l = await layoutFlow(flowOf(base));
    expect(l.screens.H.y + l.screens.H.h + NOTE_H).toBeLessThanOrEqual(l.lanes[0].y);
    expect(l.screens.H.x).toBe(l.screens.A1.x);
  });

  it("tiles an enter:any lane in screen order", async () => {
    const l = await layoutFlow(flowOf(base));
    expect([l.screens.X1.col, l.screens.X2.col]).toEqual([0, 1]);
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
  it("starts a lane's screens past where the lane begins, leaving room for lines into its first column", async () => {
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
    expect(l.screens.M1.col).toBe(0);
    expect(l.screens.M1.x).toBeGreaterThanOrEqual(LANE_X + 100);
    expect(l.width).toBeGreaterThanOrEqual(l.screens.M1.x + FRAME_W);
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
    expect([l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([0, 1, 2]);
    expect([l.screens.B1.col, l.screens.B2a.col]).toEqual([0, 1]);
  });

  it("orders a cycle between lane screens from where the flow enters it", async () => {
    const text = base.replace("  - { from: A3, to: H, kind: back }\n", "  - { from: A3, to: A1, label: Again }\n");
    const l = await layoutFlow(flowOf(text));
    expect([l.screens.A1.col, l.screens.A2.col, l.screens.A3.col]).toEqual([0, 1, 2]);
  });

  it("reads a cycle from the screen the flow comes into the lane at, not the first one listed", async () => {
    const text = base.replace(
      "  - { from: H, to: A1 }\n  - { from: A1, to: A2 }\n  - { from: A2, to: A3 }\n  - { from: A3, to: H, kind: back }\n",
      "  - { from: H, to: A2 }\n  - { from: A2, to: A3 }\n  - { from: A3, to: A1 }\n  - { from: A1, to: A2, label: Again }\n",
    );
    const l = await layoutFlow(flowOf(text));
    expect([l.screens.A2.col, l.screens.A3.col, l.screens.A1.col]).toEqual([0, 1, 2]);
  });
});
