import * as elkModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { Flow, Screen } from "./flow.ts";

/** Width of a phone-sized frame; wider viewports scale up from here. */
export const FRAME_W = 180;
export const FRAME_H = 360;
const MAX_FRAME_W = 480;
const MAX_FRAME_H = 640;
const DEFAULT_VP = { width: 390, height: 844 };

/** On-canvas size of a screen's frame: its viewport scaled to FRAME_W per 390 CSS px, capped. */
export function frameSize(flow: Flow, screen: Screen): { width: number; height: number } {
  const vp = screen.viewport ?? flow.viewport ?? DEFAULT_VP;
  const scale = Math.min(FRAME_W / DEFAULT_VP.width, MAX_FRAME_W / vp.width, MAX_FRAME_H / vp.height);
  const s = vp.width <= DEFAULT_VP.width ? FRAME_W / vp.width : scale;
  return { width: Math.round(vp.width * s), height: Math.round(vp.height * s) };
}
/** Space above a frame for its id and title. */
export const LABEL_H = 46;
/** Space below a frame for its note. */
export const NOTE_H = 44;
const COL_GAP = 120;
const STACK_GAP = 24;
/** Padding inside a lane above and below its frames. */
export const LANE_PAD = 32;
const LANE_GAP = 56;
const ORIGIN_X = 40;
const ORIGIN_Y = 40;
const EMPTY_LANE_H = 160;
/** Where lanes start on the left; their screens, and the entry row above them, start LANE_INSET further in. */
export const LANE_X = ORIGIN_X;
const LANE_INSET = 110;
/** A step with more screens than this in one lane goes on in the next column, so no lane grows very tall. */
export const MAX_STACK = 3;
const slotH = (h: number) => LABEL_H + h + NOTE_H;

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
  pinned: boolean;
}
export interface LaneBox {
  id: string;
  y: number;
  height: number;
}
export interface Layout {
  screens: Record<string, ScreenBox>;
  lanes: LaneBox[];
  width: number;
  height: number;
}
export type Overrides = Record<string, { x: number; y: number }>;

type ElkCtor = new () => { layout(graph: ElkNode): Promise<ElkNode> };
const mod = elkModule as unknown as { default: ElkCtor | { default: ElkCtor } };
const ELK: ElkCtor = typeof mod.default === "function" ? mod.default : mod.default.default;
const elk = new ELK();

/**
 * Edges that move the flow forward: `back` edges, edges into a lane-less entry
 * screen, and edges that close a cycle (found by DFS from the entries, then from
 * `entered`, the screens the flow comes into from elsewhere, in declaration
 * order) are dropped so ELK never reverses the main path.
 */
export function forwardEdges(flow: Flow, ids: string[], entered: ReadonlySet<string> = new Set()) {
  const inSet = new Set(ids);
  const entries = new Set(flow.screens.filter((s) => !s.lane).map((s) => s.id));
  const candidates = flow.edges.filter(
    (e) => e.kind !== "back" && inSet.has(e.from) && inSet.has(e.to) && e.from !== e.to && !entries.has(e.to),
  );
  const out = new Map<string, typeof candidates>();
  for (const e of candidates) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const state = new Map<string, 1 | 2>();
  const keep = new Set<(typeof candidates)[number]>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const st = state.get(e.to);
      if (st === 1) continue; // closes a cycle
      keep.add(e);
      if (!st) visit(e.to);
    }
    state.set(id, 2);
  };
  const hasIncoming = new Set(candidates.map((e) => e.to));
  const roots = [...ids.filter((id) => entries.has(id)), ...ids.filter((id) => entered.has(id)), ...ids.filter((id) => !hasIncoming.has(id)), ...ids];
  for (const r of roots) if (!state.has(r)) visit(r);
  return candidates.filter((e) => keep.has(e));
}

/**
 * Column (layer) and in-layer order for one lane's screens, from the lane's own forward edges. One graph, so the
 * screens of one step share a layer even where parts of the lane do not connect; a layer's frames overlap in x
 * whatever their widths, so each run of overlapping frames is one column.
 */
async function rank(flow: Flow, ids: string[], entered: ReadonlySet<string>): Promise<Map<string, { col: number; order: number }>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "20",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.separateConnectedComponents": "false",
    },
    children: ids.map((id, i) => {
      const size = frameSize(flow, flow.screens.find((s) => s.id === id)!);
      return { id, width: size.width, height: slotH(size.height), layoutOptions: { "elk.position": `(0,${i})` } };
    }),
    edges: forwardEdges(flow, ids, entered).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const res = new Map<string, { col: number; order: number }>();
  let col = -1;
  let right = -Infinity;
  for (const c of [...(out.children ?? [])].sort((a, b) => (a.x ?? 0) - (b.x ?? 0))) {
    const x = c.x ?? 0;
    if (x >= right) {
      col++;
      right = x + (c.width ?? 0);
    } else right = Math.max(right, x + (c.width ?? 0));
    res.set(c.id, { col, order: c.y ?? 0 });
  }
  return res;
}

/**
 * Screens without a lane sit in a row above the lanes. Each lane is laid out on its own, from its start on the
 * left: its screens follow its own edges left to right, branches of one step stack in one column (up to
 * MAX_STACK, then the next column), and an `enter: any` lane tiles its screens in order. Edges between lanes do
 * not shape the layout; the canvas shows them as links on their screens.
 */
export async function layoutFlow(flow: Flow, overrides: Overrides = {}): Promise<Layout> {
  const size = new Map(flow.screens.map((sc) => [sc.id, frameSize(flow, sc)]));
  const laneOf = new Map(flow.screens.map((sc) => [sc.id, sc.lane]));
  const stackHeight = (ids: string[]) => ids.reduce((h, id) => h + slotH(size.get(id)!.height), 0) + Math.max(0, ids.length - 1) * STACK_GAP;
  const x0 = LANE_X + LANE_INSET;
  const screens: Record<string, ScreenBox> = {};
  let y = ORIGIN_Y;

  const entries = flow.screens.filter((sc) => !sc.lane);
  if (entries.length) {
    let x = x0;
    entries.forEach((sc, i) => {
      const { width: w, height: h } = size.get(sc.id)!;
      screens[sc.id] = { x, y: y + LABEL_H, w, h, col: i, pinned: false };
      x += w + COL_GAP;
    });
    y += slotH(Math.max(...entries.map((sc) => size.get(sc.id)!.height))) + LANE_GAP;
  }

  const lanes: LaneBox[] = [];
  for (const lane of flow.lanes) {
    const ids = flow.screens.filter((sc) => sc.lane === lane.id).map((sc) => sc.id);
    let cols: string[][];
    if (lane.enter === "any") cols = ids.map((id) => [id]);
    else {
      // Where the flow comes into the lane from elsewhere: a cycle inside the lane is read from there.
      const entered = new Set(flow.edges.filter((e) => e.kind !== "back" && laneOf.get(e.from) !== lane.id && laneOf.get(e.to) === lane.id).map((e) => e.to));
      const ranks = ids.length ? await rank(flow, ids, entered) : new Map<string, { col: number; order: number }>();
      const byCol = new Map<number, string[]>();
      for (const id of ids) {
        const c = ranks.get(id)!.col;
        byCol.set(c, [...(byCol.get(c) ?? []), id]);
      }
      cols = [...byCol.keys()]
        .sort((a, b) => a - b)
        .flatMap((c) => {
          const step = byCol.get(c)!.sort((a, b) => ranks.get(a)!.order - ranks.get(b)!.order);
          const out: string[][] = [];
          for (let i = 0; i < step.length; i += MAX_STACK) out.push(step.slice(i, i + MAX_STACK));
          return out;
        });
    }
    const inner = cols.length ? Math.max(...cols.map(stackHeight)) : EMPTY_LANE_H;
    let x = x0;
    cols.forEach((ids, c) => {
      let sy = y + LANE_PAD + (inner - stackHeight(ids)) / 2;
      for (const id of ids) {
        const { width: w, height: h } = size.get(id)!;
        screens[id] = { x, y: sy + LABEL_H, w, h, col: c, pinned: false };
        sy += slotH(h) + STACK_GAP;
      }
      x += Math.max(FRAME_W, ...ids.map((id) => size.get(id)!.width)) + COL_GAP;
    });
    lanes.push({ id: lane.id, y, height: inner + 2 * LANE_PAD });
    y += inner + 2 * LANE_PAD + LANE_GAP;
  }

  for (const [id, pos] of Object.entries(overrides))
    if (screens[id]) screens[id] = { ...screens[id], x: pos.x, y: pos.y, pinned: true };

  const boxes = Object.values(screens);
  const bottom = lanes.length ? lanes.at(-1)!.y + lanes.at(-1)!.height : ORIGIN_Y;
  const width = Math.max(x0 + FRAME_W, ...boxes.map((b) => b.x + b.w)) + ORIGIN_X;
  const height = Math.max(bottom, ...boxes.map((b) => b.y + b.h + NOTE_H)) + ORIGIN_Y;
  return { screens, lanes, width, height };
}
