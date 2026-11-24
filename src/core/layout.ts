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
 * screen, and edges that close a cycle (found by DFS from the entries, in
 * declaration order) are dropped so ELK never reverses the main path.
 */
export function forwardEdges(flow: Flow, ids: string[]) {
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
  const roots = [...ids.filter((id) => entries.has(id)), ...ids.filter((id) => !hasIncoming.has(id)), ...ids];
  for (const r of roots) if (!state.has(r)) visit(r);
  return candidates.filter((e) => keep.has(e));
}

/** Column (layer) and in-layer order for every screen that takes part in layering. */
async function rank(flow: Flow, ids: string[]): Promise<Map<string, { col: number; order: number }>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "20",
      "elk.layered.crossingMinimization.semiInteractive": "true",
    },
    children: ids.map((id, i) => ({
      id,
      width: frameSize(flow, flow.screens.find((s) => s.id === id)!).width,
      height: slotH(frameSize(flow, flow.screens.find((s) => s.id === id)!).height),
      layoutOptions: { "elk.position": `(0,${i})` },
    })),
    edges: forwardEdges(flow, ids).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const xs = [...new Set((out.children ?? []).map((c) => Math.round(c.x ?? 0)))].sort((a: number, b: number) => a - b);
  const res = new Map<string, { col: number; order: number }>();
  for (const c of out.children ?? []) res.set(c.id, { col: xs.indexOf(Math.round(c.x ?? 0)), order: c.y ?? 0 });
  return res;
}

export async function layoutFlow(flow: Flow, overrides: Overrides = {}): Promise<Layout> {
  const tiled = new Set(flow.lanes.filter((l) => l.enter === "any").map((l) => l.id));
  const ranked = flow.screens.filter((s) => !s.lane || !tiled.has(s.lane)).map((s) => s.id);
  const ranks = ranked.length ? await rank(flow, ranked) : new Map();

  // Lane-less screens always sit in column 0; everything ELK put in column 0 alongside them stays there.
  const col = new Map<string, number>();
  const order = new Map<string, number>();
  const shift = flow.screens.some((s) => !s.lane && (ranks.get(s.id)?.col ?? 0) > 0) ? 1 : 0;
  for (const s of flow.screens) {
    const r = ranks.get(s.id);
    if (r) {
      col.set(s.id, s.lane ? Math.max(r.col + shift, flow.screens.some((t) => !t.lane) ? 1 : 0) : 0);
      order.set(s.id, r.order);
    }
  }
  for (const lane of flow.lanes.filter((l) => tiled.has(l.id)))
    flow.screens.filter((s) => s.lane === lane.id).forEach((s, i) => {
      col.set(s.id, i + 1);
      order.set(s.id, 0);
    });

  const size = new Map(flow.screens.map((sc) => [sc.id, frameSize(flow, sc)]));
  const entries = flow.screens.filter((sc) => !sc.lane);
  // Column x positions: each column is as wide as its widest frame.
  const maxCol = Math.max(0, ...[...col.values()]);
  const colW: number[] = Array.from({ length: maxCol + 1 }, () => FRAME_W);
  for (const sc of flow.screens) {
    const c = sc.lane ? (col.get(sc.id) ?? 0) : 0;
    colW[c] = Math.max(colW[c], size.get(sc.id)!.width);
  }
  const colX: number[] = [];
  let cx = ORIGIN_X;
  for (let c = 0; c <= maxCol; c++) {
    colX[c] = cx;
    cx += colW[c] + COL_GAP;
  }
  const stackHeight = (ids: string[]) => ids.reduce((h, id) => h + slotH(size.get(id)!.height), 0) + Math.max(0, ids.length - 1) * STACK_GAP;

  const screens: Record<string, ScreenBox> = {};
  const lanes: LaneBox[] = [];
  let y = ORIGIN_Y;
  for (const lane of flow.lanes) {
    const members = flow.screens.filter((sc) => sc.lane === lane.id);
    const byCol = new Map<number, string[]>();
    for (const sc of members) {
      const c = col.get(sc.id) ?? 0;
      byCol.set(c, [...(byCol.get(c) ?? []), sc.id]);
    }
    const inner = byCol.size ? Math.max(...[...byCol.values()].map(stackHeight)) : EMPTY_LANE_H;
    const height = inner + 2 * LANE_PAD;
    for (const [c, ids] of byCol) {
      ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      let sy = y + LANE_PAD + (inner - stackHeight(ids)) / 2;
      for (const id of ids) {
        const { width: w, height: h } = size.get(id)!;
        screens[id] = { x: colX[c], y: sy + LABEL_H, w, h, col: c, pinned: false };
        sy += slotH(h) + STACK_GAP;
      }
    }
    lanes.push({ id: lane.id, y, height });
    y += height + LANE_GAP;
  }

  const top = lanes.length ? lanes[0].y : ORIGIN_Y;
  const bottom = lanes.length ? lanes.at(-1)!.y + lanes.at(-1)!.height : ORIGIN_Y + stackHeight(entries.map((e) => e.id));
  // Centre the frames themselves (not their label/note slots) across the lanes.
  const framesH = entries.reduce((h, e) => h + size.get(e.id)!.height, 0) + Math.max(0, entries.length - 1) * (LABEL_H + NOTE_H + STACK_GAP);
  let ey = (top + bottom) / 2 - framesH / 2 - LABEL_H;
  // ey is the top of the first entry's slot; its frame starts LABEL_H lower.
  for (const sc of entries) {
    const { width: w, height: h } = size.get(sc.id)!;
    screens[sc.id] = { x: ORIGIN_X, y: ey + LABEL_H, w, h, col: 0, pinned: false };
    ey += slotH(h) + STACK_GAP;
  }

  for (const [id, pos] of Object.entries(overrides))
    if (screens[id]) screens[id] = { ...screens[id], x: pos.x, y: pos.y, pinned: true };

  const boxes = Object.values(screens);
  const width = Math.max(ORIGIN_X, ...boxes.map((b) => b.x + b.w)) + ORIGIN_X;
  const height = Math.max(bottom, ...boxes.map((b) => b.y + b.h + NOTE_H)) + ORIGIN_Y;
  return { screens, lanes, width, height };
}
