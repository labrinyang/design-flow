import { MOTION_KEEP, MOTION_MIN_AREA } from "./motion.ts";

/**
 * At most this many screens show as live frames at once; the others show their picture. A live frame is a whole
 * page in its own process, so this caps the canvas's memory however far it zooms out or however many screens fit.
 */
export const LIVE_MAX = 16;

export interface LiveBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Has a picture to show instead. */
  picture: boolean;
}

/**
 * Which screens are live frames: those on screen and at least as big as a frame must be for its motion to play
 * (motion.ts), the biggest first, then the nearest the middle. A screen without its picture yet is live while on
 * screen at any size if there is room, so the canvas never shows a blank where it could show the screen. `keep`
 * (screens live now) need a little less, so a frame does not flicker at the threshold; `force` are live
 * whatever their size, such as the screen a comment is being written on.
 */
export function pickLive(
  boxes: LiveBox[],
  v: { x: number; y: number; zoom: number },
  view: { width: number; height: number },
  keep: ReadonlySet<string>,
  force: ReadonlySet<string> = new Set(),
  max = LIVE_MAX,
): Set<string> {
  const cx = view.width / 2;
  const cy = view.height / 2;
  const ranked: { id: string; rank: number; d: number }[] = [];
  for (const b of boxes) {
    const w = b.w * v.zoom;
    const h = b.h * v.zoom;
    const x = b.x * v.zoom + v.x;
    const y = b.y * v.zoom + v.y;
    if (x >= view.width || y >= view.height || x + w <= 0 || y + h <= 0) continue;
    const big = w * h >= MOTION_MIN_AREA * (keep.has(b.id) ? MOTION_KEEP : 1);
    if (!big && b.picture) continue;
    ranked.push({ id: b.id, rank: big ? w * h : 0, d: Math.hypot(x + w / 2 - cx, y + h / 2 - cy) });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.d - b.d);
  const live = new Set(ranked.slice(0, max).map((r) => r.id));
  for (const id of force) if (boxes.some((b) => b.id === id)) live.add(id);
  return live;
}
