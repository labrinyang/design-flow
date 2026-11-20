import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { Badge, Edge, Flow, Lane, Screen, Tone } from "../../src/core/flow.ts";
import { FRAME_H, FRAME_W, LABEL_H, NOTE_H, type Layout } from "../../src/core/layout.ts";

export interface ScreenData extends Record<string, unknown> {
  screen: Screen;
  tone: Tone;
  pinned: boolean;
  flow: Flow;
  width: number;
  height: number;
  /** Set by the canvas: the frame forwards clicks as element comments. */
  commenting: boolean;
}
export interface LaneData extends Record<string, unknown> {
  lane: Lane;
  width: number;
  height: number;
}
export interface EdgeData extends Record<string, unknown> {
  label?: string;
  tone: Tone;
  dashed: boolean;
  edge: Edge;
  index: number;
  /** Set by the canvas while a comment on this edge is being written. */
  marked?: boolean;
}
export type ScreenNode = RFNode<ScreenData, "screen">;
export type LaneNode = RFNode<LaneData, "lane">;
export type FlowNode = ScreenNode | LaneNode;
export type FlowEdge = RFEdge<EdgeData, "flow">;

export const LANE_X = 230;

export function laneOf(flow: Flow, screenId: string): Lane | undefined {
  const s = flow.screens.find((x) => x.id === screenId);
  return s?.lane ? flow.lanes.find((l) => l.id === s.lane) : undefined;
}

export function toneOfEdge(flow: Flow, e: Edge): Tone {
  if (e.kind === "error") return "danger";
  return laneOf(flow, e.from)?.tone ?? "neutral";
}

export function toReactFlow(flow: Flow, layout: Layout): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const laneWidth = Math.max(layout.width - LANE_X, FRAME_W * 2);
  const entryRight = Math.max(0, ...flow.screens.filter((s) => !s.lane).map((s) => layout.screens[s.id].x + layout.screens[s.id].w));
  const laneX = Math.max(LANE_X, entryRight + 10);
  const nodes: FlowNode[] = [
    ...flow.lanes.map(
      (lane): LaneNode => {
        const box = layout.lanes.find((l) => l.id === lane.id)!;
        return {
          id: `lane:${lane.id}`,
          type: "lane",
          position: { x: laneX, y: box.y },
          data: { lane, width: layout.width - laneX, height: box.height },
          draggable: false,
          selectable: false,
          zIndex: -1,
          style: { width: layout.width - laneX, height: box.height },
        };
      },
    ),
    ...flow.screens.map((screen): ScreenNode => {
      const box = layout.screens[screen.id];
      return {
        id: screen.id,
        type: "screen",
        position: { x: box.x, y: box.y },
        data: { screen, tone: laneOf(flow, screen.id)?.tone ?? "neutral", pinned: box.pinned, flow, width: box.w, height: box.h, commenting: false },
        width: box.w,
        height: box.h,
        style: { width: box.w, height: box.h },
      };
    }),
  ];
  const edges: FlowEdge[] = flow.edges.map((e, index) => {
    const a = layout.screens[e.from];
    const b = layout.screens[e.to];
    const leftwards = b.x + b.w <= a.x;
    return {
    id: flow.edges.findIndex((x) => x.from === e.from && x.to === e.to) === index ? `${e.from}->${e.to}` : `${e.from}->${e.to}#${index}`,
    type: "flow",
    source: e.from,
    target: e.to,
    sourceHandle: leftwards ? "out-left" : "out-right",
    targetHandle: leftwards ? "in-right" : "in-left",
    data: { label: e.label, tone: toneOfEdge(flow, e), dashed: e.kind === "back", edge: e, index },
    };
  });
  return { nodes, edges };
}

export type LegendItem = { kind: "lane"; tone: Tone; label: string } | { kind: "badge"; badge: Badge };

const BADGE_ORDER: Badge[] = ["home", "video", "timer"];
export function legendOf(flow: Flow): LegendItem[] {
  const used = new Set(flow.screens.flatMap((s) => s.badges));
  return [
    ...flow.lanes.map((l): LegendItem => ({ kind: "lane", tone: l.tone, label: l.title })),
    ...BADGE_ORDER.filter((b) => used.has(b)).map((badge): LegendItem => ({ kind: "badge", badge })),
  ];
}

export { FRAME_H, FRAME_W, LABEL_H, NOTE_H };
