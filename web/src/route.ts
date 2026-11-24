/**
 * Routes the canvas's edges as right-angled lines that go around frames (with their titles and
 * notes), spreads apart lines that would run along the same stretch, and puts each label where it
 * covers no frame, title, note or other label.
 *
 * Lines run on a sparse grid: vertical lines down the middle of every gap between frames, and
 * horizontal lines through every gap, every line end and the lanes' top and bottom padding. Each
 * edge takes its cheapest path on that grid (length, plus a cost per bend). Forward edges prefer
 * the padding above a row and ways back the padding below it, so the two read apart.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export type Side = "left" | "right";

export interface RouteScreen {
  id: string;
  /** The frame; lines attach to its left and right sides. */
  frame: Rect;
  /** What lines and labels keep clear of: the frame with its title above and its note below. */
  block: Rect;
}
export interface RouteEdge {
  from: string;
  to: string;
  /** The label's size, when the edge has one. */
  label?: { w: number; h: number };
  /** A way back: prefers the padding below a row. */
  back?: boolean;
}
/** A band where one kind of edge should run: forward edges above a row's middle, ways back below it. */
export interface Zone {
  y0: number;
  y1: number;
  prefer: "forward" | "back";
}
export interface RouteInput {
  screens: RouteScreen[];
  edges: RouteEdge[];
  /** Areas such as lane titles and notes: labels never cover them, lines cross them only when there is no other way. */
  obstacles?: Rect[];
  /** Extra horizontal lines routes may use, such as the lanes' padding. */
  channels?: number[];
  zones?: Zone[];
  /** Lines that routes should not run right along, such as lane borders. */
  borders?: { x: number[]; y: number[] };
}
export interface Routed {
  points: Point[];
  label?: Point;
  sides: [Side, Side];
}

/** Gap kept between a line and a frame, title or note. */
const CLEAR = 12;
/** Gap between lines that share a stretch. */
const SPACING = 10;
/** Gap between line ends on one side of a frame. */
const PORT_GAP = 16;
/** Gap between level lines that run side by side between the same two frames: room for a label on each. */
const LEVEL_GAP = 24;
/** A bend costs as much as this many pixels of line. */
const BEND = 80;
/** Room around everything, for lines that go round the outside. */
const MARGIN = 64;
/** Extra cost per line already using a grid step, so later lines look for room of their own. */
const USED = 0.15;
/** Cost factor for running sideways in a band meant for the other kind of edge. */
const OFF_ZONE = 2;
/** Cost of crossing a lane title or note, in pixels of line. */
const SOFT = 400;

const OPP = [1, 0, 3, 2];

const half = (v: number) => Math.round(v * 2) / 2;
const inflate = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Lines through the middle of every gap at least `min` wide between consecutive coordinates. */
function midlines(coords: number[], min: number): number[] {
  const s = [...new Set(coords.map(half))].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i++) if (s[i + 1] - s[i] >= min) out.push(half((s[i] + s[i + 1]) / 2));
  return out;
}

/** Which sides of the source and target frames an edge leaves and enters by. */
export function sidesOf(a: Rect, b: Rect): [Side, Side] {
  if (b.x0 >= a.x1) return ["right", "left"];
  if (b.x1 <= a.x0) return ["left", "right"];
  // Frames in the same column: out and back in on the same side, round the outside.
  return b.x0 + b.x1 < a.x0 + a.x1 ? ["left", "left"] : ["right", "right"];
}

interface Grid {
  xs: number[];
  ys: number[];
  ny: number;
  free: Uint8Array;
  /** Point k connects to the next point along x (east) or along y (south): 0 no, 1 yes, 2 yes but through a lane title or note. */
  east: Uint8Array;
  south: Uint8Array;
  /** Cost factor for running along each horizontal line: [forward edges, ways back]. */
  rowCost: [Float64Array, Float64Array];
}

function buildGrid(solid: Rect[], soft: Rect[], xs: number[], ys: number[], zones: Zone[]): Grid {
  const nx = xs.length;
  const ny = ys.length;
  const free = new Uint8Array(nx * ny);
  const east = new Uint8Array(nx * ny);
  const south = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    const x = xs[i];
    const cuts = solid.filter((b) => b.x0 < x && x < b.x1);
    const marks = soft.filter((b) => b.x0 < x && x < b.x1);
    for (let j = 0; j < ny; j++) if (!cuts.some((b) => b.y0 < ys[j] && ys[j] < b.y1)) free[i * ny + j] = 1;
    for (let j = 0; j + 1 < ny; j++) {
      const k = i * ny + j;
      if (free[k] && free[k + 1] && !cuts.some((b) => b.y0 < ys[j + 1] && b.y1 > ys[j]))
        south[k] = marks.some((b) => b.y0 < ys[j + 1] && b.y1 > ys[j]) ? 2 : 1;
    }
  }
  for (let j = 0; j < ny; j++) {
    const y = ys[j];
    const cuts = solid.filter((b) => b.y0 < y && y < b.y1);
    const marks = soft.filter((b) => b.y0 < y && y < b.y1);
    for (let i = 0; i + 1 < nx; i++) {
      const k = i * ny + j;
      if (free[k] && free[k + ny] && !cuts.some((b) => b.x0 < xs[i + 1] && b.x1 > xs[i]))
        east[k] = marks.some((b) => b.x0 < xs[i + 1] && b.x1 > xs[i]) ? 2 : 1;
    }
  }
  const forward = new Float64Array(ny).fill(1);
  const back = new Float64Array(ny).fill(1);
  ys.forEach((y, j) => {
    for (const z of zones) if (y >= z.y0 && y < z.y1) (z.prefer === "forward" ? back : forward)[j] = OFF_ZONE;
  });
  return { xs, ys, ny, free, east, south, rowCost: [forward, back] };
}

/** The first grid point straight out from a line end, past its own frame's margin; -1 if something is in the way. */
function stubNode(g: Grid, solid: Rect[], own: number, p: Point, side: Side): number {
  const j = g.ys.indexOf(p.y);
  if (j < 0) return -1;
  const step = side === "right" ? 1 : -1;
  let i = -1;
  if (side === "right") i = g.xs.findIndex((x) => x > p.x);
  else for (let k = g.xs.length - 1; k >= 0 && i < 0; k--) if (g.xs[k] < p.x) i = k;
  for (; i >= 0 && i < g.xs.length; i += step) {
    const x = g.xs[i];
    const lo = Math.min(x, p.x);
    const hi = Math.max(x, p.x);
    if (solid.some((b, k) => k !== own && b.y0 < p.y && p.y < b.y1 && b.x0 < hi && b.x1 > lo)) return -1;
    if (g.free[i * g.ny + j]) return i * g.ny + j;
  }
  return -1;
}

class Heap {
  private f: number[] = [];
  private s: number[] = [];
  get size() {
    return this.f.length;
  }
  push(f: number, s: number) {
    const a = this.f;
    const b = this.s;
    let i = a.length;
    a.push(f);
    b.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= f) break;
      a[i] = a[p];
      b[i] = b[p];
      i = p;
    }
    a[i] = f;
    b[i] = s;
  }
  pop(): [number, number] {
    const a = this.f;
    const b = this.s;
    const top: [number, number] = [a[0], b[0]];
    const f = a.pop()!;
    const s = b.pop()!;
    const n = a.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && a[l + 1] < a[l] ? l + 1 : l;
        if (a[c] >= f) break;
        a[i] = a[c];
        b[i] = b[c];
        i = c;
      }
      a[i] = f;
      b[i] = s;
    }
    return top;
  }
}

/**
 * Cheapest grid path from point `from` (leaving in direction `fromDir`) to point `to`, which must be
 * left in direction `toDir` for the last `toLen` pixels to the line end. Directions: 0 +x, 1 −x, 2 +y, 3 −y.
 */
function search(g: Grid, from: number, fromDir: number, to: number, toDir: number, toLen: number, used: Map<number, number>, back: boolean) {
  const { xs, ys, ny, east, south } = g;
  const rowCost = g.rowCost[back ? 1 : 0];
  const n = xs.length * ny;
  const END = n * 4;
  const dist = new Float64Array(END + 1).fill(Infinity);
  const prev = new Int32Array(END + 1).fill(-1);
  const tx = xs[Math.floor(to / ny)];
  const ty = ys[to % ny];
  const h = (k: number) => Math.abs(xs[Math.floor(k / ny)] - tx) + Math.abs(ys[k % ny] - ty) + toLen;
  const heap = new Heap();
  const s0 = from * 4 + fromDir;
  dist[s0] = 0;
  heap.push(h(from), s0);
  while (heap.size) {
    const [f, s] = heap.pop();
    if (s === END) break;
    const k = s >> 2;
    const dir = s & 3;
    const d0 = dist[s];
    if (d0 + h(k) < f - 1e-6) continue;
    if (k === to && dir !== OPP[toDir]) {
      const c = d0 + toLen + (dir === toDir ? 0 : BEND);
      if (c < dist[END]) {
        dist[END] = c;
        prev[END] = s;
        heap.push(c, END);
      }
    }
    const i = Math.floor(k / ny);
    const j = k % ny;
    for (let d = 0; d < 4; d++) {
      if (d === OPP[dir]) continue;
      let nb = -1;
      let len = 0;
      let key = 0;
      let link = 0;
      if (d === 0) {
        if (east[k]) [nb, len, key, link] = [k + ny, xs[i + 1] - xs[i], k * 2, east[k]];
      } else if (d === 1) {
        if (i > 0 && east[k - ny]) [nb, len, key, link] = [k - ny, xs[i] - xs[i - 1], (k - ny) * 2, east[k - ny]];
      } else if (d === 2) {
        if (south[k]) [nb, len, key, link] = [k + 1, ys[j + 1] - ys[j], k * 2 + 1, south[k]];
      } else if (j > 0 && south[k - 1]) [nb, len, key, link] = [k - 1, ys[j] - ys[j - 1], (k - 1) * 2 + 1, south[k - 1]];
      if (nb < 0) continue;
      const c =
        d0 + len * (d < 2 ? rowCost[j] : 1) * (1 + USED * (used.get(key) ?? 0)) + (d === dir ? 0 : BEND) + (link === 2 ? SOFT : 0);
      const ns = nb * 4 + d;
      if (c < dist[ns] - 1e-9) {
        dist[ns] = c;
        prev[ns] = s;
        heap.push(c + h(nb), ns);
      }
    }
  }
  if (prev[END] < 0) return undefined;
  const path: number[] = [];
  for (let s = prev[END]; s >= 0; s = prev[s]) path.push(s >> 2);
  path.reverse();
  for (let i = 0; i + 1 < path.length; i++) {
    const a = Math.min(path[i], path[i + 1]);
    const key = Math.abs(path[i] - path[i + 1]) === ny ? a * 2 : a * 2 + 1;
    used.set(key, (used.get(key) ?? 0) + 1);
  }
  return path;
}

/** Drops repeated points and points in the middle of a straight stretch. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) out[out.length - 1] = { ...p };
    else out.push({ ...p });
  }
  return out;
}

/** -1 if the line turns up after leaving this end, 1 if down, 0 if it never changes height. */
function turnAt(points: Point[], start: boolean): -1 | 0 | 1 {
  const seq = start ? points : [...points].reverse();
  for (const p of seq) if (p.y !== seq[0].y) return p.y < seq[0].y ? -1 : 1;
  return 0;
}

/** x of the first vertical stretch after this end. */
function trackAt(points: Point[], start: boolean): number {
  const seq = start ? points : [...points].reverse();
  for (let i = 0; i + 1 < seq.length; i++) if (seq[i].x === seq[i + 1].x) return seq[i].x;
  return seq[0].x;
}

interface Job {
  a: number;
  b: number;
  sides: [Side, Side];
  back: boolean;
}
interface Ports {
  sy: number;
  ty: number;
}

/**
 * Spreads the line ends on each side of a frame. Level lines stay in the middle so they run
 * straight; lines that turn up sit above them and lines that turn down below, ordered so no
 * stub crosses another line on its way out. The other ends sit on a lattice that is offset by
 * half a step between right and left sides, so stubs that face each other across a gap never
 * share a height.
 */
function assignPorts(screens: RouteScreen[], jobs: (Job | undefined)[], routes: (Point[] | undefined)[]): (Ports | undefined)[] {
  const mid = (i: number) => (screens[i].frame.y0 + screens[i].frame.y1) / 2;
  const ports: (Ports | undefined)[] = jobs.map((j) => j && { sy: mid(j.a), ty: mid(j.b) });
  interface End {
    job: number;
    source: boolean;
    turn: -1 | 0 | 1;
    track: number;
  }
  const bySide = new Map<string, End[]>();
  jobs.forEach((j, n) => {
    const r = routes[n];
    if (!j || !r || j.a === j.b) return;
    for (const source of [true, false]) {
      const key = `${source ? j.a : j.b}|${j.sides[source ? 0 : 1]}`;
      bySide.set(key, [...(bySide.get(key) ?? []), { job: n, source, turn: turnAt(r, source), track: trackAt(r, source) }]);
    }
  });
  for (const [key, ends] of bySide) {
    const [si, side] = key.split("|");
    const f = screens[Number(si)].frame;
    const m = (f.y0 + f.y1) / 2;
    const right = side === "right";
    const out = (e: End) => (right ? e.track : -e.track);
    // A stub that runs further out must pass below the lines turning up inside it, and above those turning down.
    const ups = ends.filter((e) => e.turn < 0).sort((a, b) => out(a) - out(b));
    const downs = ends.filter((e) => e.turn > 0).sort((a, b) => out(b) - out(a));
    const level = ends.filter((e) => e.turn === 0).sort((a, b) => a.job - b.job);
    const placed: [End, number][] = [];
    const lattice = m + (right ? 0 : PORT_GAP / 2);
    const snap = (y: number, round: (k: number) => number) => lattice + round((y - lattice) / PORT_GAP + 0) * PORT_GAP;
    if (level.length) {
      const top = m - ((level.length - 1) / 2) * LEVEL_GAP;
      const bottom = top + (level.length - 1) * LEVEL_GAP;
      level.forEach((e, i) => placed.push([e, top + i * LEVEL_GAP]));
      // Lattice points at least one step clear of the level lines.
      const above = snap(top - PORT_GAP, (k) => Math.floor(k + 1e-9));
      const below = snap(bottom + PORT_GAP, (k) => Math.ceil(k - 1e-9));
      ups.forEach((e, i) => placed.push([e, above - (ups.length - 1 - i) * PORT_GAP]));
      downs.forEach((e, i) => placed.push([e, below + i * PORT_GAP]));
    } else {
      const all = [...ups, ...downs];
      const start = snap(m - ((all.length - 1) / 2) * PORT_GAP, Math.round);
      all.forEach((e, i) => placed.push([e, start + i * PORT_GAP]));
    }
    // Squeeze into the frame if there are too many.
    const lo = f.y0 + 8;
    const hi = f.y1 - 8;
    const ys = placed.map(([, y]) => y);
    const span = Math.max(...ys) - Math.min(...ys);
    const k = span > hi - lo ? (hi - lo) / span : 1;
    const c = (Math.max(...ys) + Math.min(...ys)) / 2;
    for (const [e, y] of placed) {
      const v = half(Math.min(hi, Math.max(lo, m + (y - c) * k + (c - m))));
      if (e.source) ports[e.job]!.sy = v;
      else ports[e.job]!.ty = v;
    }
  }
  // A level line between two frames stays level even if their middles differ by a pixel.
  jobs.forEach((j, n) => {
    const r = routes[n];
    const p = ports[n];
    if (!j || !r || !p || turnAt(r, true) !== 0) return;
    const t = screens[j.b].frame;
    if (p.sy >= t.y0 + 8 && p.sy <= t.y1 - 8) p.ty = p.sy;
  });
  return ports;
}

interface Seg {
  r: number;
  i: number;
  vertical: boolean;
  c: number;
  a: number;
  b: number;
  fixed: boolean;
}

function segmentsOf(routes: (Point[] | undefined)[], vertical: boolean): Seg[] {
  const out: Seg[] = [];
  routes.forEach((pts, r) => {
    if (!pts) return;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const v = p.x === q.x;
      if (v !== vertical) continue;
      out.push({
        r,
        i,
        vertical: v,
        c: v ? p.x : p.y,
        a: Math.min(v ? p.y : p.x, v ? q.y : q.x),
        b: Math.max(v ? p.y : p.x, v ? q.y : q.x),
        // The first and last stretches end at a frame; they cannot move sideways.
        fixed: i === 0 || i === pts.length - 2,
      });
    }
  });
  return out;
}

/**
 * Order of lines sharing a stretch, left to right (vertical) or top to bottom (horizontal), chosen so
 * the lines they turn into cross as little as possible. Each end turns toward lower (-1) or higher (+1)
 * coordinates, or is a frame (0).
 */
function sortKey(s: Seg, routes: (Point[] | undefined)[]): [number, number, number] {
  const pts = routes[s.r]!;
  const p = pts[s.i];
  const q = pts[s.i + 1];
  const turn = (end: Point, other: Point | undefined) => (other ? Math.sign(s.vertical ? other.x - end.x : other.y - end.y) : 0);
  const tp = turn(p, pts[s.i - 1]);
  const tq = turn(q, pts[s.i + 2]);
  const pFirst = (s.vertical ? p.y : p.x) <= (s.vertical ? q.y : q.x);
  const e1 = pFirst ? tp : tq;
  const e2 = pFirst ? tq : tp;
  const sum = e1 + e2;
  const span = s.b - s.a;
  if (sum === -2) return [sum, 0, span];
  if (sum === 2) return [sum, 0, -span];
  if (sum === 0 && e1 === -1) return [0, -1, -s.a];
  if (sum === 0 && e1 === 1) return [0, 1, s.a];
  return [sum, 0, s.a];
}

/** Moves lines that share a stretch of the same grid line apart, within the room the frames leave. */
function nudge(routes: (Point[] | undefined)[], blocks: Rect[]) {
  for (const vertical of [true, false]) {
    const groups = new Map<number, Seg[]>();
    for (const s of segmentsOf(routes, vertical)) groups.set(s.c, [...(groups.get(s.c) ?? []), s]);
    for (const group of groups.values()) {
      group.sort((s, t) => s.a - t.a);
      let cluster: Seg[] = [];
      let end = -Infinity;
      const flush = () => {
        if (cluster.length > 1) spread(cluster, routes, blocks);
        cluster = [];
        end = -Infinity;
      };
      for (const s of group) {
        if (cluster.length && s.a > end + 1) flush();
        cluster.push(s);
        end = Math.max(end, s.b);
      }
      flush();
    }
  }
}

function spread(cluster: Seg[], routes: (Point[] | undefined)[], blocks: Rect[]) {
  const keys = new Map(cluster.map((s) => [s, sortKey(s, routes)]));
  cluster.sort((s, t) => {
    const a = keys.get(s)!;
    const b = keys.get(t)!;
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || s.r - t.r;
  });
  const n = cluster.length;
  const fixed = cluster.findIndex((s) => s.fixed);
  const base = fixed >= 0 ? fixed : (n - 1) / 2;
  const c = cluster[0].c;
  const lo = Math.min(...cluster.map((s) => s.a));
  const hi = Math.max(...cluster.map((s) => s.b));
  let before = Infinity;
  let after = Infinity;
  for (const b of blocks) {
    const [b0, b1, a0, a1] = cluster[0].vertical ? [b.x0, b.x1, b.y0, b.y1] : [b.y0, b.y1, b.x0, b.x1];
    if (a0 >= hi || a1 <= lo) continue;
    if (b1 <= c) before = Math.min(before, c - b1);
    else if (b0 >= c) after = Math.min(after, b0 - c);
  }
  const low = before - CLEAR / 2;
  const high = after - CLEAR / 2;
  let step = SPACING;
  let shift = 0;
  if (fixed >= 0) {
    // A frame-bound stretch stays put; the others fit round it.
    if (base > 0) step = Math.min(step, low / base);
    if (n - 1 - base > 0) step = Math.min(step, high / (n - 1 - base));
  } else {
    // Slide the group toward the roomier side; squeeze it only if it does not fit at all.
    const min = -low + base * step;
    const max = high - (n - 1 - base) * step;
    if (min <= max) shift = Math.min(max, Math.max(min, 0));
    else {
      step = (low + high) / (n - 1);
      shift = -low + base * step;
    }
  }
  step = Math.max(step, 2);
  cluster.forEach((s, k) => {
    const o = (k - base) * step + shift;
    if (s.fixed || !o) return;
    const pts = routes[s.r]!;
    if (s.vertical) {
      pts[s.i].x += o;
      pts[s.i + 1].x += o;
    } else {
      pts[s.i].y += o;
      pts[s.i + 1].y += o;
    }
  });
}

const lengthOf = (pts: Point[]) => pts.reduce((l, p, i) => (i ? l + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0);

/** Does the segment p–q pass through the box? */
function crosses(p: Point, q: Point, box: Rect): boolean {
  if (p.x === q.x) return p.x > box.x0 && p.x < box.x1 && Math.max(p.y, q.y) > box.y0 && Math.min(p.y, q.y) < box.y1;
  return p.y > box.y0 && p.y < box.y1 && Math.max(p.x, q.x) > box.x0 && Math.min(p.x, q.x) < box.x1;
}

/**
 * Puts each label on its own line: on a horizontal stretch where it fits, else a vertical one,
 * away from frames, titles, notes and the labels placed before it, crossing as few other lines as it can.
 */
function placeLabels(routes: (Point[] | undefined)[], sizes: ({ w: number; h: number } | undefined)[], blocks: Rect[]): (Point | undefined)[] {
  const out: (Point | undefined)[] = routes.map(() => undefined);
  const placed: Rect[] = [];
  const keepOff = blocks.map((b) => inflate(b, 2));
  const order = routes
    .map((_, k) => k)
    .filter((k) => routes[k] && sizes[k])
    .sort((a, b) => lengthOf(routes[a]!) - lengthOf(routes[b]!));
  for (const k of order) {
    const pts = routes[k]!;
    const { w, h } = sizes[k]!;
    let best: { score: number; p: Point; box: Rect } | undefined;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const vertical = p.x === q.x;
      const [a, b] = vertical ? [Math.min(p.y, q.y), Math.max(p.y, q.y)] : [Math.min(p.x, q.x), Math.max(p.x, q.x)];
      const need = vertical ? h : w;
      // Keep corners visible, and the arrowhead on the last stretch.
      const last = i === pts.length - 2;
      const towardEnd = vertical ? q.y > p.y : q.x > p.x;
      const padA = 8 + (last && !towardEnd ? 12 : 0);
      const padB = 8 + (last && towardEnd ? 12 : 0);
      const from = a + need / 2 + padA;
      const to = b - need / 2 - padB;
      const centre = (a + b) / 2;
      const short = from > to;
      // The middle of the stretch if the label fits there, else as close to it as it fits; then steps either way.
      const start = short ? centre : Math.min(to, Math.max(from, centre));
      const spots = [start];
      if (!short) for (let d = 12; start - d >= from || start + d <= to; d += 12) spots.push(...[start - d, start + d].filter((s) => s >= from && s <= to));
      for (const s of spots) {
        const at = vertical ? { x: p.x, y: s } : { x: s, y: p.y };
        const box = { x0: at.x - w / 2, y0: at.y - h / 2, x1: at.x + w / 2, y1: at.y + h / 2 };
        let score = (vertical ? 30 : 0) + (short ? 80 : 0) + Math.abs(s - centre) * 0.1 - Math.min(b - a, 400) * 0.03;
        for (const o of keepOff) {
          const v = overlap(box, o);
          if (v > 0) score += 1000 + v;
        }
        for (const o of placed) {
          const v = overlap(box, inflate(o, 3));
          if (v > 0) score += 1000 + v;
        }
        routes.forEach((r, n) => {
          if (n === k || !r) return;
          for (let m = 0; m + 1 < r.length; m++) if (crosses(r[m], r[m + 1], box)) score += 20;
        });
        if (!best || score < best.score) best = { score, p: at, box };
      }
    }
    if (best) {
      out[k] = best.p;
      placed.push(best.box);
    }
  }
  return out;
}

export function routeEdges(input: RouteInput): (Routed | undefined)[] {
  const { screens, edges } = input;
  if (!screens.length) return edges.map(() => undefined);
  const index = new Map(screens.map((s, i) => [s.id, i]));
  const blocks = [...screens.map((s) => s.block), ...(input.obstacles ?? [])];
  // Lines never cross frames; they keep clear of lane titles and notes too, unless that leaves no way through.
  const solid = screens.map((s) => inflate(s.block, CLEAR));
  const soft = (input.obstacles ?? []).map((b) => inflate(b, CLEAR / 2));
  const all = blocks.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }));
  const bounds = inflate(all, MARGIN);
  const channels = (input.channels ?? []).map(half);
  const zones = input.zones ?? [];
  // Lines down the middle of each gap between frames, plus lines that pass beside lane titles and notes.
  const lines = (axis: "x" | "y") => {
    const ends = (bs: Rect[]) => bs.flatMap((b) => (axis === "x" ? [b.x0, b.x1] : [b.y0, b.y1]));
    const fixed = [...(input.borders?.[axis] ?? []), ...(axis === "x" ? [bounds.x0, bounds.x1] : [bounds.y0, bounds.y1])];
    const frames = ends(screens.map((s) => s.block));
    return [...new Set([...midlines([...frames, ...fixed], 2 * CLEAR), ...midlines([...frames, ...ends(input.obstacles ?? []), ...fixed], 2 * CLEAR)])].sort(
      (a, b) => a - b,
    );
  };
  const xs = lines("x");
  const ys0 = [...lines("y"), ...channels];

  const jobs: (Job | undefined)[] = edges.map((e) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) return undefined;
    const sides: [Side, Side] = a === b ? ["right", "right"] : sidesOf(screens[a].frame, screens[b].frame);
    return { a, b, sides, back: !!e.back || sides[0] === "left" };
  });

  const run = (ports: (Ports | undefined)[]) => {
    const ys = [...new Set([...ys0, ...ports.flatMap((p) => (p ? [half(p.sy), half(p.ty)] : []))])].sort((a, b) => a - b);
    const g = buildGrid(solid, soft, xs, ys, zones);
    const used = new Map<number, number>();
    const routes: (Point[] | undefined)[] = jobs.map(() => undefined);
    const end = (j: Job, source: boolean, p: Ports): Point => {
      const f = screens[source ? j.a : j.b].frame;
      return { x: j.sides[source ? 0 : 1] === "right" ? f.x1 : f.x0, y: half(source ? p.sy : p.ty) };
    };
    const order = jobs
      .map((_, n) => n)
      .filter((n) => jobs[n] && ports[n])
      .sort((m, n) => {
        const d = (k: number) => {
          const P = end(jobs[k]!, true, ports[k]!);
          const Q = end(jobs[k]!, false, ports[k]!);
          return Math.abs(P.x - Q.x) + Math.abs(P.y - Q.y);
        };
        return d(m) - d(n);
      });
    for (const n of order) {
      const j = jobs[n]!;
      if (j.a === j.b) {
        // A screen that leads back to itself: a small loop off its right side.
        const f = screens[j.a].frame;
        routes[n] = [
          { x: f.x1, y: f.y0 + 24 },
          { x: f.x1 + 28, y: f.y0 + 24 },
          { x: f.x1 + 28, y: f.y0 + 52 },
          { x: f.x1, y: f.y0 + 52 },
        ];
        continue;
      }
      const P = end(j, true, ports[n]!);
      const Q = end(j, false, ports[n]!);
      const s = stubNode(g, solid, j.a, P, j.sides[0]);
      const t = stubNode(g, solid, j.b, Q, j.sides[1]);
      if (s < 0 || t < 0) continue;
      const path = search(g, s, j.sides[0] === "right" ? 0 : 1, t, j.sides[1] === "left" ? 0 : 1, Math.abs(g.xs[Math.floor(t / g.ny)] - Q.x), used, j.back);
      if (path) routes[n] = simplify([P, ...path.map((k) => ({ x: g.xs[Math.floor(k / g.ny)], y: g.ys[k % g.ny] })), Q]);
    }
    return routes;
  };

  // First pass with every line end in the middle of its side, to learn which way each line turns.
  const first = jobs.map((j) => {
    if (!j) return undefined;
    const a = screens[j.a].frame;
    const b = screens[j.b].frame;
    const sy = (a.y0 + a.y1) / 2;
    const ty = (b.y0 + b.y1) / 2;
    // Facing frames whose middles differ by a pixel or two get one level line.
    return { sy, ty: j.sides[0] !== j.sides[1] && Math.abs(sy - ty) <= 3 ? sy : ty };
  });
  const rough = run(first);
  nudge(
    rough,
    screens.map((s) => s.block),
  );
  const routes = run(assignPorts(screens, jobs, rough));
  // Only frames limit how far apart lines may spread; lane titles and notes are low and short.
  nudge(
    routes,
    screens.map((s) => s.block),
  );
  const labels = placeLabels(
    routes,
    edges.map((e) => e.label),
    blocks,
  );
  return routes.map((points, n) => (points && jobs[n] ? { points, label: labels[n], sides: jobs[n]!.sides } : undefined));
}

/** An SVG path along the points, with rounded corners. */
export function roundedPath(points: Point[], radius = 6): string {
  if (!points.length) return "";
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let d = `M${r2(points[0].x)},${r2(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1];
    const c = points[i];
    const q = points[i + 1];
    const lin = Math.abs(c.x - p.x) + Math.abs(c.y - p.y);
    const lout = Math.abs(q.x - c.x) + Math.abs(q.y - c.y);
    const r = Math.min(radius, lin / 2, lout / 2);
    const a = { x: c.x - (Math.sign(c.x - p.x) * r || 0), y: c.y - (Math.sign(c.y - p.y) * r || 0) };
    const b = { x: c.x + (Math.sign(q.x - c.x) * r || 0), y: c.y + (Math.sign(q.y - c.y) * r || 0) };
    d += `L${r2(a.x)},${r2(a.y)}Q${r2(c.x)},${r2(c.y)} ${r2(b.x)},${r2(b.y)}`;
  }
  const last = points[points.length - 1];
  return d + `L${r2(last.x)},${r2(last.y)}`;
}
