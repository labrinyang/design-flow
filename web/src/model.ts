import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { Badge, Edge, Flow, Lane, Screen, Tone } from "../../src/core/flow.ts";
import { FRAME_H, FRAME_W, LABEL_H, LANE_PAD, NOTE_H, type Layout } from "../../src/core/layout.ts";
import { roundedPath, routeEdges, type Point, type Rect, type Routed } from "./route.ts";

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
  /** The routed line, if routing found one. */
  route?: EdgeRoute;
}
export interface EdgeRoute {
  /** SVG path of the line. */
  d: string;
  label?: Point;
  /** Where React Flow puts the line's ends while both frames sit at their layout positions. Ends anywhere else mean a frame is being dragged. */
  ends: { sx: number; sy: number; tx: number; ty: number };
}
export type ScreenNode = RFNode<ScreenData, "screen">;
export type LaneNode = RFNode<LaneData, "lane">;
export type FlowNode = ScreenNode | LaneNode;
export type FlowEdge = RFEdge<EdgeData, "flow">;

export const LANE_X = 230;
/** How far a lane's title rises above the lane's box (LaneNodeView places it at -top-3.5). */
export const LANE_TITLE_OVERHANG = 16;

export function laneOf(flow: Flow, screenId: string): Lane | undefined {
  const s = flow.screens.find((x) => x.id === screenId);
  return s?.lane ? flow.lanes.find((l) => l.id === s.lane) : undefined;
}

export function toneOfEdge(flow: Flow, e: Edge): Tone {
  if (e.kind === "error") return "danger";
  return laneOf(flow, e.from)?.tone ?? "neutral";
}

/** Text width in canvas pixels. */
export type Measure = (text: string, font: { size: number; weight: number }) => number;
const estimate: Measure = (text, f) => text.length * f.size * (f.weight >= 500 ? 0.58 : 0.54);

export interface ReactFlowOptions {
  /** Measures label, lane title and lane note text; an estimate by default. */
  measure?: Measure;
  /** The text after the titles of lanes with enter: any. */
  enterAny?: string;
}

/** An edge label's padding (px-1.5 on each side) and height (13px text, py-px). */
const LABEL_PAD_X = 12;
const LABEL_BOX_H = 22;

/** Routes every edge around the frames, lane titles and lane notes; see route.ts. */
function routeFlow(flow: Flow, layout: Layout, laneX: number, opts: ReactFlowOptions): (Routed | undefined)[] {
  const measure = opts.measure ?? estimate;
  const screens = flow.screens.flatMap((s) => {
    const b = layout.screens[s.id];
    if (!b) return [];
    const frame = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
    return [{ id: s.id, frame, block: { ...frame, y0: b.y - LABEL_H, y1: b.y + b.h + (s.note ? NOTE_H : 0) } }];
  });
  // Where LaneNodeView draws them: the title (18px, px-2.5) at -top-3.5 left-6, the note (13px) at bottom-3 left-6.
  const obstacles: Rect[] = [];
  for (const lane of flow.lanes) {
    const box = layout.lanes.find((l) => l.id === lane.id);
    if (!box) continue;
    const extra = lane.enter === "any" && opts.enterAny ? 12 + measure(opts.enterAny, { size: 12, weight: 400 }) : 0;
    obstacles.push({ x0: laneX + 24, y0: box.y - 14, x1: laneX + 24 + 20 + measure(lane.title, { size: 18, weight: 500 }) + extra, y1: box.y + 14 });
    if (lane.note)
      obstacles.push({ x0: laneX + 24, y0: box.y + box.height - 32, x1: laneX + 24 + measure(lane.note, { size: 13, weight: 400 }), y1: box.y + box.height - 12 });
  }
  return routeEdges({
    screens,
    edges: flow.edges.map((e) => ({
      from: e.from,
      to: e.to,
      back: e.kind === "back",
      label: e.label ? { w: measure(e.label, { size: 13, weight: 500 }) * 1.06 + LABEL_PAD_X, h: LABEL_BOX_H } : undefined,
    })),
    obstacles,
    channels: layout.lanes.flatMap((l) => [l.y + LANE_PAD / 2, l.y + l.height - LANE_PAD / 2]),
    // Forward edges skip over a lane's frames through its top half, ways back go under them.
    zones: layout.lanes.flatMap((l) => [
      { y0: l.y, y1: l.y + l.height / 2, prefer: "forward" as const },
      { y0: l.y + l.height / 2, y1: l.y + l.height, prefer: "back" as const },
    ]),
    borders: { x: [laneX, layout.width], y: layout.lanes.flatMap((l) => [l.y, l.y + l.height]) },
  });
}

export function toReactFlow(flow: Flow, layout: Layout, opts: ReactFlowOptions = {}): { nodes: FlowNode[]; edges: FlowEdge[] } {
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
  const routes = routeFlow(flow, layout, laneX, opts);
  const edges: FlowEdge[] = flow.edges.map((e, index) => {
    const a = layout.screens[e.from];
    const b = layout.screens[e.to];
    const r = routes[index];
    const [out, into] = r?.sides ?? (b.x + b.w <= a.x ? ["left", "right"] : ["right", "left"]);
    const route: EdgeRoute | undefined = r && {
      d: roundedPath(r.points),
      label: r.label,
      ends: { sx: out === "right" ? a.x + a.w : a.x, sy: a.y + a.h / 2, tx: into === "right" ? b.x + b.w : b.x, ty: b.y + b.h / 2 },
    };
    return {
      id: flow.edges.findIndex((x) => x.from === e.from && x.to === e.to) === index ? `${e.from}->${e.to}` : `${e.from}->${e.to}#${index}`,
      type: "flow",
      source: e.from,
      target: e.to,
      sourceHandle: out === "left" ? "out-left" : "out-right",
      targetHandle: into === "left" ? "in-left" : "in-right",
      data: { label: e.label, tone: toneOfEdge(flow, e), dashed: e.kind === "back", edge: e, index, route },
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
