import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { Badge, Edge, Flow, Lane, Screen, Tone } from "../../src/core/flow.ts";
import { FRAME_H, FRAME_W, LABEL_H, LANE_PAD, LANE_X, NOTE_H, type Layout } from "../../src/core/layout.ts";
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
  /** Screens in other lanes this screen leads to, and those that lead to it: links on the screen instead of lines. */
  out: LinkEnd[];
  into: LinkEnd[];
}
/** A screen at the other end of an edge between lanes. */
export interface LinkEnd {
  id: string;
  title: string;
  /** The first such edge's label: what the user does. */
  label?: string;
  tone: Tone;
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
  /** Runs between lanes, so it is drawn only for the screen in focus. */
  link?: boolean;
  /** Another screen is in focus and this line does not touch it. */
  faded?: boolean;
  /** Touches the screen in focus. */
  focus?: boolean;
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

/**
 * How far a lane's title rises above the lane's box: LaneNodeView sits it on the box's top edge, 6px into the box,
 * and it grows upward when zoomed out, clear of the first screens' labels below.
 */
export const LANE_TITLE_OVERHANG = 22;

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

/**
 * What the board draws once lanes are collapsed, and the routing problems for its lines: lines inside a lane are
 * always drawn; links between lanes (and to and from the entry screens) only for the screen in focus.
 */
export interface BoardPlan {
  board: Board;
  lines: BoardEdge[];
  links: BoardEdge[];
  laneX: number;
  /** Collapsed lanes' rows, by lane node id: links into and out of a collapsed lane end there. */
  rows: Map<string, Rect & { screens: number }>;
  input: RouteInput;
  linksInput: RouteInput;
}

const labelOf = (line: BoardEdge) => (line.count > 1 ? `×${line.count}` : line.edge.label);

export function planBoard(flow: Flow, layout: Layout, opts: ReactFlowOptions = {}): BoardPlan {
  const measure = opts.measure ?? estimate;
  const laneX = LANE_X;
  const board = collapseLanes(flow, layout, opts.collapsed ?? new Set());
  const all = boardEdges(flow, board);
  const lines = all.filter((l) => inLane(flow, l.edge));
  const links = all.filter((l) => !inLane(flow, l.edge));
  const rows: BoardPlan["rows"] = new Map();
  for (const lane of flow.lanes) {
    if (!board.collapsed.has(lane.id)) continue;
    const box = board.layout.lanes.find((l) => l.id === lane.id)!;
    const screens = flow.screens.filter((s) => s.lane === lane.id).length;
    const summary = opts.laneSummary?.(screens) ?? String(screens);
    const w = ROW_CHROME + measure(lane.title, { size: 18, weight: 500 }) + measure(summary, { size: 13, weight: 400 });
    // Where an expanded lane's title starts (LaneNodeView).
    const x0 = laneX + ROW_INSET;
    rows.set(laneNodeId(lane.id), { x0, y0: box.y, x1: x0 + Math.ceil(w), y1: box.y + box.height, screens });
  }
  return {
    board,
    lines,
    links,
    laneX,
    rows,
    input: routeInput(flow, board, lines, laneX, rows, measure, opts.enterAny),
    linksInput: routeInput(flow, board, links, laneX, rows, measure, opts.enterAny),
  };
}

/** Both ends in the same lane, or both in none (the entry row). */
export function inLane(flow: Flow, e: Edge): boolean {
  const lane = (id: string) => flow.screens.find((s) => s.id === id)?.lane ?? "";
  return lane(e.from) === lane(e.to);
}

/** For each screen, the screens in other lanes it leads to and comes from, one each, in the order of the edges. */
export function linkEnds(flow: Flow): Map<string, { out: LinkEnd[]; into: LinkEnd[] }> {
  const byId = new Map(flow.screens.map((s) => [s.id, s]));
  const ends = new Map(flow.screens.map((s) => [s.id, { out: [] as LinkEnd[], into: [] as LinkEnd[] }]));
  const endOf = (id: string, label?: string): LinkEnd | undefined => {
    const s = byId.get(id);
    return s && { id, title: s.title, ...(label ? { label } : {}), tone: laneOf(flow, id)?.tone ?? "neutral" };
  };
  for (const e of flow.edges) {
    if (inLane(flow, e)) continue;
    const from = ends.get(e.from);
    const to = ends.get(e.to);
    const target = endOf(e.to, e.label);
    const source = endOf(e.from, e.label);
    if (from && target && !from.out.some((x) => x.id === e.to)) from.out.push(target);
    if (to && source && !to.into.some((x) => x.id === e.from)) to.into.push(source);
  }
  return ends;
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
  // Where LaneNodeView draws them: the title (18px, px-2.5) on the top edge at left-6, the note (13px) at bottom-3 left-6.
  const obstacles: Rect[] = [];
  for (const lane of flow.lanes) {
    const box = layout.lanes.find((l) => l.id === lane.id);
    if (!box || board.collapsed.has(lane.id)) continue;
    const extra = lane.enter === "any" && enterAny ? 12 + measure(enterAny, { size: 12, weight: 400 }) : 0;
    obstacles.push({ x0: laneX + 24, y0: box.y - LANE_TITLE_OVERHANG, x1: laneX + 24 + 20 + LANE_TITLE_BUTTONS + measure(lane.title, { size: 18, weight: 500 }) + extra, y1: box.y + 6 });
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
  const ends = linkEnds(flow);
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
          data: {
            screen,
            tone: laneOf(flow, screen.id)?.tone ?? "neutral",
            pinned: box.pinned,
            flow,
            width: box.w,
            height: box.h,
            commenting: false,
            live: false,
            out: ends.get(screen.id)?.out ?? [],
            into: ends.get(screen.id)?.into ?? [],
          },
          width: box.w,
          height: box.h,
          style: { width: box.w, height: box.h },
        };
      }),
  ];
  const routes = opts.routes ?? routeEdges(plan.input);
  return { nodes, edges: lines.map((line, n) => toEdge(flow, plan, line, routes[n])), plan };
}

/**
 * The links between lanes that touch one screen, as lines for when it is in focus, with their routes when the
 * canvas has them (routed together, from plan.linksInput).
 */
export function focusEdges(flow: Flow, plan: BoardPlan, routes: (Routed | undefined)[] | undefined, screen: string): FlowEdge[] {
  return plan.links.flatMap((line, n) => (line.from === screen || line.to === screen ? [toEdge(flow, plan, line, routes?.[n], true)] : []));
}

function toEdge(flow: Flow, plan: BoardPlan, line: BoardEdge, r: Routed | undefined, link = false): FlowEdge {
  const e = line.edge;
  const boxOf = (id: string) => {
    const row = plan.rows.get(id);
    return row ? { x: row.x0, y: row.y0, w: row.x1 - row.x0, h: row.y1 - row.y0 } : plan.board.layout.screens[id];
  };
  const a = boxOf(line.from);
  const b = boxOf(line.to);
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
    data: {
      label: labelOf(line),
      tone: toneOfEdge(flow, e),
      dashed: e.kind === "back",
      edge: e,
      index: line.index,
      route,
      ...(folded ? { folded } : {}),
      ...(link ? { link } : {}),
    },
  };
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

export { FRAME_H, FRAME_W, LABEL_H, LANE_X, NOTE_H };
