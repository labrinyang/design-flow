import type { Anchor, Point } from "../../src/core/comments.ts";
import type { Edge, Flow } from "../../src/core/flow.ts";
import { LABEL_H, NOTE_H, type Layout, type ScreenBox } from "../../src/core/layout.ts";

/** Height of a collapsed lane: one row with its title. */
export const COLLAPSED_LANE_H = 64;

/**
 * The board as drawn with some lanes collapsed to a row with their title: those lanes' screens are left out and
 * everything below moves up. Comments keep points on the full board, so the canvas converts both ways.
 */
export interface Board {
  layout: Layout;
  /** Collapsed lanes that exist in the flow. */
  collapsed: ReadonlySet<string>;
  /** Screens not drawn because their lane is collapsed. */
  hidden: ReadonlySet<string>;
  /** The collapsed lane a point of the full board falls in, by height. */
  collapsedAt(p: Point): string | undefined;
  /** Where a point of the full board is drawn; one inside a collapsed lane goes to that lane's row. */
  toView(p: Point): Point;
  /** The point of the full board drawn at `p`. */
  toFull(p: Point): Point;
}

export function collapseLanes(flow: Flow, layout: Layout, collapsed: ReadonlySet<string>): Board {
  let before = 0;
  const cuts = [...layout.lanes]
    .filter((l) => collapsed.has(l.id))
    .sort((a, b) => a.y - b.y)
    .map((l) => {
      const row = Math.min(l.height, COLLAPSED_LANE_H);
      // top: where the row is drawn, once the collapsed lanes above it have given their room back.
      const cut = { id: l.id, y0: l.y, y1: l.y + l.height, row, saved: l.height - row, top: l.y - before };
      before += cut.saved;
      return cut;
    });
  if (!cuts.length)
    return { layout, collapsed: new Set(), hidden: new Set(), collapsedAt: () => undefined, toView: (p) => p, toFull: (p) => p };
  /** How far a point at full-board height `y` moves up: the room given back by collapsed lanes that end above it. */
  const shiftAt = (y: number) => cuts.reduce((s, c) => (c.y1 <= y ? s + c.saved : s), 0);
  const cutAt = (y: number) => cuts.find((c) => y >= c.y0 && y < c.y1);
  const shut = new Set(cuts.map((c) => c.id));
  const hidden = new Set(flow.screens.filter((s) => s.lane && shut.has(s.lane)).map((s) => s.id));
  const screens: Record<string, ScreenBox> = {};
  for (const [id, b] of Object.entries(layout.screens)) if (!hidden.has(id)) screens[id] = { ...b, y: b.y - shiftAt(b.y) };
  // Entry screens (in no lane) beside a collapsed lane go up to its row, as far as the entry screens above them allow,
  // instead of staying as far down as the lane used to reach.
  const entries = flow.screens
    .filter((s) => !s.lane && screens[s.id])
    .map((s) => ({ id: s.id, y0: layout.screens[s.id].y }))
    .sort((a, b) => a.y0 - b.y0);
  let prev: { y0: number; y: number; h: number } | undefined;
  for (const e of entries) {
    const box = screens[e.id];
    const c = cutAt(e.y0);
    const want = c ? c.top : box.y;
    // Never closer to the one above than they were, nor than its title, frame and note need.
    box.y = prev ? Math.max(want, prev.y + Math.min(e.y0 - prev.y0, prev.h + NOTE_H + 24 + LABEL_H)) : want;
    prev = { y0: e.y0, y: box.y, h: box.h };
  }
  const lanes = layout.lanes.map((l) => {
    const c = cuts.find((x) => x.id === l.id);
    return { ...l, y: l.y - shiftAt(l.y), height: c ? c.row : l.height };
  });
  return {
    layout: { ...layout, screens, lanes, height: layout.height - before },
    collapsed: shut,
    hidden,
    collapsedAt: (p) => cutAt(p.y)?.id,
    toView: (p) => {
      const c = cutAt(p.y);
      return c ? { x: p.x, y: c.top + c.row / 2 } : { x: p.x, y: p.y - shiftAt(p.y) };
    },
    toFull: (p) => {
      let shift = 0;
      for (const c of cuts) {
        if (p.y < c.top) break;
        if (p.y < c.top + c.row) return { x: p.x, y: c.y0 + (p.y - c.top) };
        shift += c.saved;
      }
      return { x: p.x, y: p.y + shift };
    },
  };
}

/** Where an anchor's point (on the full board) is drawn; undefined when it is inside a collapsed lane. */
export function drawnPoint(a: Anchor, full: Layout, board: Board): Point | undefined {
  if (a.type === "element" || a.type === "screen") {
    if (board.hidden.has(a.screen)) return undefined;
    // On its screen: moved with the screen, wherever the screen's lane is.
    const from = full.screens[a.screen];
    const to = board.layout.screens[a.screen];
    if (from && to) return { x: a.point.x - from.x + to.x, y: a.point.y - from.y + to.y };
  }
  if (a.type === "lane" ? board.collapsed.has(a.lane) : board.collapsedAt(a.point)) return undefined;
  return board.toView(a.point);
}

/** The point on the full board of an anchor made on the board as drawn. */
export function fullPoint(a: Anchor, full: Layout, board: Board): Point {
  if (a.type === "element" || a.type === "screen") {
    const from = board.layout.screens[a.screen];
    const to = full.screens[a.screen];
    if (from && to) return { x: a.point.x - from.x + to.x, y: a.point.y - from.y + to.y };
  }
  return board.toFull(a.point);
}

/** Open comments in each lane: on its screens, on the lane itself, or at a point inside it. */
export function commentsByLane(flow: Flow, layout: Layout, anchors: Anchor[]): Map<string, number> {
  const laneOf = new Map(flow.screens.map((s) => [s.id, s.lane]));
  const out = new Map<string, number>();
  for (const a of anchors) {
    const lane =
      a.type === "element" || a.type === "screen"
        ? laneOf.get(a.screen)
        : a.type === "lane"
          ? a.lane
          : layout.lanes.find((l) => a.point.y >= l.y && a.point.y < l.y + l.height)?.id;
    if (lane) out.set(lane, (out.get(lane) ?? 0) + 1);
  }
  return out;
}

/** A line the board draws: an edge of flow.yaml, or several that run into or out of the same collapsed lanes, drawn once. */
export interface BoardEdge {
  /** The edge, or the first of those it stands for. */
  edge: Edge;
  /** Its place in flow.yaml's edges. */
  index: number;
  /** A screen id, or lane:<id> for a collapsed lane. */
  from: string;
  to: string;
  /** How many edges of flow.yaml it stands for. */
  count: number;
}

export const laneNodeId = (lane: string) => `lane:${lane}`;

export function boardEdges(flow: Flow, board: Board): BoardEdge[] {
  const laneOf = new Map(flow.screens.map((s) => [s.id, s.lane]));
  const end = (id: string) => (board.hidden.has(id) ? laneNodeId(laneOf.get(id)!) : id);
  const out: BoardEdge[] = [];
  const merged = new Map<string, BoardEdge>();
  flow.edges.forEach((edge, index) => {
    const from = end(edge.from);
    const to = end(edge.to);
    if (from === edge.from && to === edge.to) {
      out.push({ edge, index, from, to, count: 1 });
      return;
    }
    // Lines inside one collapsed lane go with it.
    if (from === to) return;
    const key = `${from}>${to}`;
    const m = merged.get(key);
    if (m) m.count++;
    else {
      const line = { edge, index, from, to, count: 1 };
      merged.set(key, line);
      out.push(line);
    }
  });
  return out;
}
