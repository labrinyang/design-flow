import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { FRAME_W, focusEdges, LANE_X, legendOf, linkEnds, toneOfEdge, toReactFlow, type ScreenData } from "../web/src/model.ts";
import { routeEdges } from "../web/src/route.ts";

const flow = parseFlow(
  `version: 1
title: T
lanes:
  - { id: a, title: Enroll, tone: success }
  - { id: x, title: Errors, tone: danger, enter: any }
screens:
  - { id: H, title: Home }
  - { id: A1, title: Scan, lane: a, badges: [video] }
  - { id: X1, title: Timeout, lane: x, badges: [home] }
edges:
  - { from: H, to: A1, label: Enroll }
  - { from: A1, to: X1, kind: error, label: Fail }
  - { from: X1, to: H, kind: back }
`,
  "t",
).flow as Flow;

/** One lane: its lines are drawn. */
const inner = parseFlow(
  `version: 1
title: T
lanes:
  - { id: a, title: A, tone: success }
screens:
  - { id: A1, title: One, lane: a }
  - { id: A2, title: Two, lane: a }
edges:
  - { from: A1, to: A2, label: Next }
  - { from: A2, to: A1, kind: back }
`,
  "t",
).flow as Flow;

describe("toReactFlow", () => {
  it("emits lane nodes behind screen nodes at layout positions", async () => {
    const layout = await layoutFlow(flow);
    const { nodes } = toReactFlow(flow, layout);
    const lanes = nodes.filter((n) => n.type === "lane");
    expect(lanes.map((n) => n.id)).toEqual(["lane:a", "lane:x"]);
    expect(lanes.every((n) => (n.zIndex ?? 0) < 0 && n.draggable === false)).toBe(true);
    const a1 = nodes.find((n) => n.id === "A1")!;
    expect(a1.type).toBe("screen");
    expect(a1.position).toEqual({ x: layout.screens.A1.x, y: layout.screens.A1.y });
    expect(a1.data).toMatchObject({ tone: "success", screen: { id: "A1" } });
    expect(nodes.find((n) => n.id === "H")!.data).toMatchObject({ tone: "neutral" });
  });

  it("colours edges by the source lane, kind first", () => {
    expect(toneOfEdge(flow, flow.edges[0])).toBe("neutral");
    expect(toneOfEdge(flow, flow.edges[1])).toBe("danger");
    expect(toneOfEdge(flow, { from: "A1", to: "H", kind: "normal" })).toBe("success");
  });

  it("emits step lines inside a lane, with labels, and dashed ways back", async () => {
    const { edges } = toReactFlow(inner, await layoutFlow(inner));
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ id: "A1->A2", type: "flow", source: "A1", target: "A2" });
    expect(edges[0].data).toMatchObject({ label: "Next", tone: "success", dashed: false });
    expect(edges[1].data).toMatchObject({ dashed: true });
  });

  it("draws no line between lanes, and puts each link on the screens at its ends", async () => {
    const { edges, nodes, plan } = toReactFlow(flow, await layoutFlow(flow));
    expect(edges).toEqual([]);
    expect(plan.links.map((l) => `${l.from}>${l.to}`)).toEqual(["H>A1", "A1>X1", "X1>H"]);
    const a1 = nodes.find((n) => n.id === "A1")!.data as ScreenData;
    expect(a1.into).toEqual([{ id: "H", title: "Home", label: "Enroll", tone: "neutral" }]);
    expect(a1.out).toEqual([{ id: "X1", title: "Timeout", label: "Fail", tone: "danger" }]);
  });

  it("draws a screen's links when it is in focus, routed together", async () => {
    const { plan } = toReactFlow(flow, await layoutFlow(flow));
    const lines = focusEdges(flow, plan, routeEdges(plan.linksInput), "A1");
    expect(lines.map((e) => e.id)).toEqual(["H->A1", "A1->X1"]);
    expect(lines.every((e) => e.data?.link && e.data.route)).toBe(true);
    expect(focusEdges(flow, plan, undefined, "X1").map((e) => e.id)).toEqual(["A1->X1", "X1->H"]);
  });

  it("lists each screen at the other end of links once, with the first edge's label", () => {
    const twice = { ...flow, edges: [...flow.edges, { from: "A1", to: "X1", label: "Retry", kind: "normal" as const }] };
    expect(linkEnds(twice).get("A1")!.out).toEqual([{ id: "X1", title: "Timeout", label: "Fail", tone: "danger" }]);
    expect(linkEnds(twice).get("X1")!.into.map((e) => e.id)).toEqual(["A1"]);
  });

  it("builds a legend from the lanes and the badges in use", () => {
    expect(legendOf(flow)).toEqual([
      { kind: "lane", tone: "success", label: "Enroll" },
      { kind: "lane", tone: "danger", label: "Errors" },
      { kind: "badge", badge: "home" },
      { kind: "badge", badge: "video" },
    ]);
  });
});

describe("toReactFlow handles", () => {
  it("joins a line that goes leftwards from the source's left side into the target's right side", async () => {
    const { edges } = toReactFlow(inner, await layoutFlow(inner), { routes: [] });
    expect(edges.find((e) => e.id === "A2->A1")).toMatchObject({ sourceHandle: "out-left", targetHandle: "in-right" });
    expect(edges.find((e) => e.id === "A1->A2")).toMatchObject({ sourceHandle: "out-right", targetHandle: "in-left" });
  });
});

describe("lane geometry", () => {
  it("starts lanes on the left, below the entry row, and ends them past the last frame", async () => {
    const layout = await layoutFlow(flow);
    const { nodes } = toReactFlow(flow, layout);
    const lane = nodes.find((n) => n.id === "lane:a")!;
    expect(lane.position.x).toBe(LANE_X);
    expect(lane.position.y).toBeGreaterThan(layout.screens.H.y + layout.screens.H.h);
    const right = Math.max(...Object.values(layout.screens).map((s) => s.x + FRAME_W));
    expect(lane.position.x + (lane.data as { width: number }).width).toBeGreaterThanOrEqual(right + 24);
  });
});

describe("parallel edges", () => {
  it("keeps two edges between the same screens apart", async () => {
    const twin = parseFlow(
      `version: 1
title: T
screens:
  - { id: A, title: A }
  - { id: B, title: B }
edges:
  - { from: A, to: B, label: Retry }
  - { from: A, to: B, label: Skip }
`,
      "t",
    ).flow as Flow;
    const { edges } = toReactFlow(twin, await layoutFlow(twin));
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
    expect(edges.map((e) => e.data?.index)).toEqual([0, 1]);
  });
});
