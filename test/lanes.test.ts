import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { boardEdges, collapseLanes, COLLAPSED_LANE_H, commentsByLane, drawnPoint, fullPoint } from "../web/src/lanes.ts";
import { focusEdges, planBoard, toReactFlow } from "../web/src/model.ts";
import { routeEdges } from "../web/src/route.ts";

const flow = parseFlow(
  `version: 1
title: T
lanes:
  - { id: a, title: Enroll }
  - { id: b, title: Pay }
  - { id: c, title: Done }
screens:
  - { id: H, title: Home }
  - { id: A1, title: Scan, lane: a }
  - { id: B1, title: Card, lane: b }
  - { id: B2, title: Confirm, lane: b }
  - { id: C1, title: Thanks, lane: c }
edges:
  - { from: H, to: A1 }
  - { from: A1, to: B1, label: Pay }
  - { from: B1, to: B2 }
  - { from: B1, to: C1 }
  - { from: B2, to: C1, label: Paid }
  - { from: C1, to: H, kind: back }
`,
  "t",
).flow as Flow;

describe("collapsing lanes", async () => {
  const layout = await layoutFlow(flow);
  const lane = (id: string) => layout.lanes.find((l) => l.id === id)!;
  const board = collapseLanes(flow, layout, new Set(["b"]));
  const saved = lane("b").height - COLLAPSED_LANE_H;

  it("folds a lane to one row, leaves its screens out and moves what is below it up", () => {
    expect([...board.hidden].sort()).toEqual(["B1", "B2"]);
    expect(board.layout.lanes.find((l) => l.id === "b")).toMatchObject({ y: lane("b").y, height: COLLAPSED_LANE_H });
    expect(board.layout.lanes.find((l) => l.id === "c")!.y).toBe(lane("c").y - saved);
    expect(board.layout.screens.C1.y).toBe(layout.screens.C1.y - saved);
    expect(board.layout.screens.A1).toEqual(layout.screens.A1);
    expect(board.layout.height).toBe(layout.height - saved);
  });

  it("keeps the entry row where it is when lanes collapse", () => {
    const all = collapseLanes(flow, layout, new Set(["a", "b", "c"]));
    expect(all.layout.screens.H).toEqual(layout.screens.H);
    expect(all.layout.lanes[0].y).toBe(layout.lanes[0].y);
  });

  it("maps points both ways, and points inside the collapsed lane onto its row", () => {
    const below = { x: 500, y: lane("c").y + 40 };
    expect(board.toView(below)).toEqual({ x: 500, y: below.y - saved });
    expect(board.toFull(board.toView(below))).toEqual(below);
    const above = { x: 500, y: lane("a").y + 10 };
    expect(board.toView(above)).toEqual(above);
    const inside = { x: 500, y: lane("b").y + lane("b").height - 5 };
    expect(board.collapsedAt(inside)).toBe("b");
    expect(board.toView(inside)).toEqual({ x: 500, y: lane("b").y + COLLAPSED_LANE_H / 2 });
    // A click on the row is kept inside the lane on the full board.
    expect(board.collapsedAt(board.toFull({ x: 500, y: lane("b").y + 10 }))).toBe("b");
  });

  it("keeps a comment on its screen as the screen moves, and hides those inside the collapsed lane", () => {
    const c1 = layout.screens.C1;
    const onC1 = { type: "screen" as const, screen: "C1", point: { x: c1.x + 10, y: c1.y + 20 } };
    const drawn = drawnPoint(onC1, layout, board)!;
    expect(drawn).toEqual({ x: c1.x + 10, y: c1.y + 20 - saved });
    expect(fullPoint({ ...onC1, point: drawn }, layout, board)).toEqual(onC1.point);
    expect(drawnPoint({ type: "screen", screen: "B1", point: { x: 0, y: 0 } }, layout, board)).toBeUndefined();
    // A point from an earlier layout, far from where the screen is now, stays on the screen.
    const stale = drawnPoint({ type: "screen", screen: "C1", point: { x: c1.x + 20000, y: c1.y + 30 } }, layout, board)!;
    expect(stale).toEqual({ x: c1.x + c1.w, y: c1.y + 30 - saved });
    expect(drawnPoint({ type: "lane", lane: "b", point: { x: 300, y: lane("b").y + 30 } }, layout, board)).toBeUndefined();
    expect(drawnPoint({ type: "canvas", point: { x: 300, y: lane("b").y + 100 } }, layout, board)).toBeUndefined();
  });

  it("draws lines into and out of the collapsed lane once per screen, with how many they stand for", () => {
    const lines = boardEdges(flow, board).map((l) => [l.from, l.to, l.count]);
    expect(lines).toEqual([
      ["H", "A1", 1],
      ["A1", "lane:b", 1],
      ["lane:b", "C1", 2],
      ["C1", "H", 1],
    ]);
    const { edges, nodes, plan } = toReactFlow(flow, layout, { collapsed: new Set(["b"]), laneSummary: (n) => `${n} screens` });
    // The one line inside the collapsed lane goes with it; links into and out of it end on its row, for the screen in focus.
    expect(edges).toEqual([]);
    const routes = routeEdges(plan.linksInput);
    const atC1 = focusEdges(flow, plan, routes, "C1");
    const atA1 = focusEdges(flow, plan, routes, "A1");
    expect(atC1.find((e) => e.source === "lane:b")).toMatchObject({ target: "C1", data: { label: "×2", folded: true } });
    expect(atA1.find((e) => e.target === "lane:b")!.data).toMatchObject({ label: "Pay", folded: true });
    expect([...atC1, ...atA1].every((e) => e.data?.route)).toBe(true);
    expect(nodes.map((n) => n.id)).not.toContain("B1");
    expect(nodes.find((n) => n.id === "lane:b")!.data).toMatchObject({ collapsed: { screens: 2, comments: 0 } });
  });

  it("routes the same problem the same way, so routes can be kept", () => {
    const one = planBoard(flow, layout, { collapsed: new Set(["b"]) });
    const two = planBoard(flow, layout, { collapsed: new Set(["b"]) });
    expect(JSON.stringify(one.input)).toBe(JSON.stringify(two.input));
    expect(JSON.stringify(planBoard(flow, layout).input)).not.toBe(JSON.stringify(one.input));
  });

  it("counts open comments per lane: on its screens, on it, or inside it", () => {
    const counts = commentsByLane(flow, layout, [
      { type: "screen", screen: "B1", point: { x: 0, y: 0 } },
      { type: "element", screen: "B2", selector: "p", tag: "p", text: "", point: { x: 0, y: 0 } },
      { type: "lane", lane: "b", point: { x: 0, y: 0 } },
      { type: "canvas", point: { x: 400, y: lane("c").y + 5 } },
      { type: "screen", screen: "H", point: { x: 0, y: 0 } },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ b: 3, c: 1 });
  });
});
