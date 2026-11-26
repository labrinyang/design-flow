import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { Badge, Edge, Flow, Lane, Screen, Tone } from "../../src/core/flow.ts";
import { FRAME_H, FRAME_W, LABEL_H, LANE_PAD, NOTE_H, type Layout } from "../../src/core/layout.ts";
import { boardEdges, collapseLanes, laneNodeId, type Board, type BoardEdge } from "./lanes.ts";
import { roundedPath, routeEdges, type Point, type Rect, type RouteInput, type RouteScreen, type Routed } from "./route.ts";

export interface ScreenData extends Record<string, unknown> {
  screen: Screen;
  tone: Tone;
  pinned: boolean;
  flow: Flow;
  width: number;
  height: number;
  /** Set by the canvas: the frame forwards clicks as element comments. */
  commenting: boolean;
  /** Set by the canvas: shown as a live frame; otherwise as its picture, or a blank card until that is drawn. */
  live: boolean;
  thumb?: string;
}
export interface LaneData extends Record<string, unknown> {
  lane: Lane;
  width: number;
  height: number;
  /** How far the title (or a collapsed lane's row) may grow to stay readable when zoomed out before it reaches a neighbour's. */
  fit: number;
  /** Set when the lane is collapsed to one row: what it holds. */
  collapsed?: { screens: number; comments: number };
}
export interface EdgeData extends Record<string, unknown> {
  label?: string;
  tone: Tone;
  dashed: boolean;
  /** The edge of flow.yaml, or the first of those a line into or out of a collapsed lane stands for. */
  edge: Edge;
  index: number;
  /** Set by the canvas while a comment on this edge is being written. */
  marked?: boolean;
  /** Stands for the edges into or out of a collapsed lane, so it is not one edge to comment on. */
  folded?: boolean;
  /** The routed line, if routing found one. */
  route?: EdgeRoute;
}
export interface EdgeRoute {
  /** SVG path of the line. */
  d: string;
  label?: Point;
  /** Where React Flow puts the line's ends; the routed line is drawn while they are where routing expected them. */
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
  /** Lanes drawn collapsed to their title row. */
  collapsed?: ReadonlySet<string>;
  /** What a collapsed lane says after its title (how many screens it holds), measured to size its row. */
  laneSummary?: (screens: number) => string;
  /** Open comments per lane, for collapsed lanes to show (lanes.ts). */
  laneComments?: ReadonlyMap<string, number>;
}

/** An edge label's padding (px-1.5 on each side) and height (13px text, py-px). */
const LABEL_PAD_X = 12;
const LABEL_BOX_H = 22;
/**
 * A collapsed lane's row around its title and summary (LaneNodeView): padding and border, the chevron, the gaps,
 * room for the comment count, and the only-this-lane button.
 */
const ROW_CHROME = 24 + 3 + 16 + 8 + 8 + 49 + 28;
/** The chevron before an expanded lane's title and the only-this-lane button after it, with their gaps (LaneNodeView). */
const LANE_TITLE_BUTTONS = 16 + 6 + 6 + 20;
/** How far into the lane area a collapsed lane's row starts, as an expanded lane's title does (left-6). */
const ROW_INSET = 24;
/** Height of a lane's title, or of a collapsed lane's row, at 100%. */
const TITLE_H = 40;

/** What the board draws once lanes are collapsed, and the routing problem for its lines. */
export interface BoardPlan {
  board: Board;
  lines: BoardEdge[];
  laneX: number;
  /** Collapsed lanes' rows, by lane node id: lines into and out of a collapsed lane end there. */
  rows: Map<string, Rect & { screens: number }>;
  input: RouteInput;
}

const labelOf = (line: BoardEdge) => (line.count > 1 ? `×${line.count}` : line.edge.label);

export function planBoard(flow: Flow, layout: Layout, opts: ReactFlowOptions = {}): BoardPlan {
  const measure = opts.measure ?? estimate;
  const entryRight = Math.max(0, ...flow.screens.filter((s) => !s.lane).map((s) => layout.screens[s.id].x + layout.screens[s.id].w));
  const laneX = Math.max(LANE_X, entryRight + 10);
  const board = collapseLanes(flow, layout, opts.collapsed ?? new Set());
  const lines = boardEdges(flow, board);
  const rows: BoardPlan["rows"] = new Map();
  for (const lane of flow.lanes) {
    if (!board.collapsed.has(lane.id)) continue;
    const box = board.layout.lanes.find((l) => l.id === lane.id)!;
    const screens = flow.screens.filter((s) => s.lane === lane.id).length;
    const summary = opts.laneSummary?.(screens) ?? String(screens);
    const w = ROW_CHROME + measure(lane.title, { size: 18, weight: 500 }) + measure(summary, { size: 13, weight: 400 });
    // Where an expanded lane's title starts (LaneNodeView), clear of the entry screens beside the lanes.
    const x0 = laneX + ROW_INSET;
    rows.set(laneNodeId(lane.id), { x0, y0: box.y, x1: x0 + Math.ceil(w), y1: box.y + box.height, screens });
  }
  return { board, lines, laneX, rows, input: routeInput(flow, board, lines, laneX, rows, measure, opts.enterAny) };
}

/** Lines go around the frames, lane titles and lane notes, and into collapsed lanes' rows; see route.ts. */
function routeInput(flow: Flow, board: Board, lines: BoardEdge[], laneX: number, rows: BoardPlan["rows"], measure: Measure, enterAny?: string): RouteInput {
  const layout = board.layout;
  const screens: RouteScreen[] = flow.screens.flatMap((s) => {
    const b = layout.screens[s.id];
    if (!b) return [];
    const frame = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
    return [{ id: s.id, frame, block: { ...frame, y0: b.y - LABEL_H, y1: b.y + b.h + (s.note ? NOTE_H : 0) } }];
  });
  for (const [id, r] of rows) {
    const frame = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
    screens.push({ id, frame, block: frame });
  }
  // Where LaneNodeView draws them: the title (18px, px-2.5) at -top-3.5 left-6, the note (13px) at bottom-3 left-6.
  const obstacles: Rect[] = [];
  for (const lane of flow.lanes) {
    const box = layout.lanes.find((l) => l.id === lane.id);
    if (!box || board.collapsed.has(lane.id)) continue;
    const extra = lane.enter === "any" && enterAny ? 12 + measure(enterAny, { size: 12, weight: 400 }) : 0;
    obstacles.push({ x0: laneX + 24, y0: box.y - 14, x1: laneX + 24 + 20 + LANE_TITLE_BUTTONS + measure(lane.title, { size: 18, weight: 500 }) + extra, y1: box.y + 14 });
    if (lane.note)
      obstacles.push({ x0: laneX + 24, y0: box.y + box.height - 32, x1: laneX + 24 + measure(lane.note, { size: 13, weight: 400 }), y1: box.y + box.height - 12 });
  }
  const open = layout.lanes.filter((l) => !board.collapsed.has(l.id));
  return {
    screens,
    edges: lines.map((line) => {
      const label = labelOf(line);
      return {
        from: line.from,
        to: line.to,
        back: line.edge.kind === "back",
        label: label ? { w: measure(label, { size: 13, weight: 500 }) * 1.06 + LABEL_PAD_X, h: LABEL_BOX_H } : undefined,
      };
    }),
    obstacles,
    channels: layout.lanes.flatMap((l) => [l.y + LANE_PAD / 2, l.y + l.height - LANE_PAD / 2]),
    // Forward edges skip over a lane's frames through its top half, ways back go under them.
    zones: open.flatMap((l) => [
      { y0: l.y, y1: l.y + l.height / 2, prefer: "forward" as const },
      { y0: l.y + l.height / 2, y1: l.y + l.height, prefer: "back" as const },
    ]),
    borders: { x: [laneX, layout.width], y: layout.lanes.flatMap((l) => [l.y, l.y + l.height]) },
  };
}

/**
 * The board as React Flow nodes and edges. Routes come from `routes` when the canvas has them (worked out off the
 * main thread, see route-cache.ts), else from routing here; a line without a route is drawn as a plain step line.
 */
export function toReactFlow(
  flow: Flow,
  layout: Layout,
  opts: ReactFlowOptions & { plan?: BoardPlan; routes?: (Routed | undefined)[] } = {},
): { nodes: FlowNode[]; edges: FlowEdge[]; plan: BoardPlan } {
  const plan = opts.plan ?? planBoard(flow, layout, opts);
  const { board, lines, laneX, rows } = plan;
  const shown = board.layout;
  // Titles grow to stay readable when zoomed out, up to half the way to the next title above or below:
  // an expanded lane's sits on its top edge, a collapsed lane's row in its middle.
  const centres = flow.lanes
    .map((lane) => {
      const box = shown.lanes.find((l) => l.id === lane.id)!;
      return { id: lane.id, y: rows.has(laneNodeId(lane.id)) ? box.y + box.height / 2 : box.y };
    })
    .sort((a, b) => a.y - b.y);
  const fit = new Map(
    centres.map((c, i) => {
      const room = Math.min(i > 0 ? c.y - centres[i - 1].y : Infinity, i < centres.length - 1 ? centres[i + 1].y - c.y : Infinity);
      return [c.id, Math.min(100, Math.max(1, (room - 8) / TITLE_H))];
    }),
  );
  const nodes: FlowNode[] = [
    ...flow.lanes.map((lane): LaneNode => {
      const box = shown.lanes.find((l) => l.id === lane.id)!;
      const row = rows.get(laneNodeId(lane.id));
      const width = row ? row.x1 - row.x0 : shown.width - laneX;
      return {
        id: laneNodeId(lane.id),
        type: "lane",
        position: { x: row ? row.x0 : laneX, y: box.y },
        data: {
          lane,
          width,
          height: box.height,
          fit: fit.get(lane.id) ?? 1,
          ...(row ? { collapsed: { screens: row.screens, comments: opts.laneComments?.get(lane.id) ?? 0 } } : {}),
        },
        draggable: false,
        selectable: false,
        // A collapsed lane's row is drawn over the lines that end in it; an expanded lane under everything.
        zIndex: row ? 0 : -1,
        width,
        height: box.height,
        style: { width, height: box.height },
      };
    }),
    ...flow.screens
      .filter((s) => !board.hidden.has(s.id))
      .map((screen): ScreenNode => {
        const box = shown.screens[screen.id];
        return {
          id: screen.id,
          type: "screen",
          position: { x: box.x, y: box.y },
          data: { screen, tone: laneOf(flow, screen.id)?.tone ?? "neutral", pinned: box.pinned, flow, width: box.w, height: box.h, commenting: false, live: false },
          width: box.w,
          height: box.h,
          style: { width: box.w, height: box.h },
        };
      }),
  ];
  const routes = opts.routes ?? routeEdges(plan.input);
  const boxOf = (id: string) => {
    const r = rows.get(id);
    return r ? { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 } : shown.screens[id];
  };
  const edges: FlowEdge[] = lines.map((line, n) => {
    const e = line.edge;
    const a = boxOf(line.from);
    const b = boxOf(line.to);
    const r = routes[n];
    const [out, into] = r?.sides ?? (b.x + b.w <= a.x ? ["left", "right"] : ["right", "left"]);
    const route: EdgeRoute | undefined = r && {
      d: roundedPath(r.points),
      label: r.label,
      ends: { sx: out === "right" ? a.x + a.w : a.x, sy: a.y + a.h / 2, tx: into === "right" ? b.x + b.w : b.x, ty: b.y + b.h / 2 },
    };
    const folded = line.from !== e.from || line.to !== e.to;
    const first = flow.edges.findIndex((x) => x.from === e.from && x.to === e.to) === line.index;
    return {
      id: folded ? `${line.from}->${line.to}` : first ? `${e.from}->${e.to}` : `${e.from}->${e.to}#${line.index}`,
      type: "flow",
      source: line.from,
      target: line.to,
      sourceHandle: out === "left" ? "out-left" : "out-right",
      targetHandle: into === "left" ? "in-left" : "in-right",
      data: { label: labelOf(line), tone: toneOfEdge(flow, e), dashed: e.kind === "back", edge: e, index: line.index, route, ...(folded ? { folded } : {}) },
    };
  });
  return { nodes, edges, plan };
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
