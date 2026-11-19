import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { FRAME_W, legendOf, toneOfEdge, toReactFlow } from "../web/src/model.ts";

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

  it("emits step edges with labels and dashed back edges", async () => {
    const { edges } = toReactFlow(flow, await layoutFlow(flow));
    expect(edges).toHaveLength(3);
    expect(edges[0]).toMatchObject({ id: "H->A1", type: "flow", source: "H", target: "A1" });
    expect(edges[0].data).toMatchObject({ label: "Enroll", tone: "neutral", dashed: false });
    expect(edges[2].data).toMatchObject({ dashed: true });
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
  it("routes an edge that goes leftwards out of the source's left side into the target's right side", async () => {
    const layout = await layoutFlow(flow);
    const { edges } = toReactFlow(flow, layout);
    const back = edges.find((e) => e.id === "X1->H")!;
    expect(back).toMatchObject({ sourceHandle: "out-left", targetHandle: "in-right" });
    const fwd = edges.find((e) => e.id === "H->A1")!;
    expect(fwd).toMatchObject({ sourceHandle: "out-right", targetHandle: "in-left" });
  });
});

describe("lane geometry", () => {
  it("starts lanes right of the entry column and ends them past the last frame", async () => {
    const layout = await layoutFlow(flow);
    const { nodes } = toReactFlow(flow, layout);
    const lane = nodes.find((n) => n.id === "lane:a")!;
    expect(lane.position.x).toBeGreaterThan(layout.screens.H.x + FRAME_W);
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
