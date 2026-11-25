import type { Viewport } from "./zoom.ts";

/**
 * A frame plays its CSS animations only while it is on screen and at least about 160 × 100 px there
 * (by area, so tall phone frames and wide desktop ones count alike). Tiny frames cannot be watched,
 * and looping animations in dozens of them keep the CPU busy for nothing.
 */
export const MOTION_MIN_AREA = 160 * 100;
/** Once playing, a frame keeps playing down to this share of that area, so one near the limit does not flip back and forth. */
export const MOTION_KEEP = 0.8;
/** Frames switch only once the canvas has stood still this long, never in the middle of a pan or zoom. */
export const MOTION_SETTLE_MS = 150;

export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether a frame (flow coordinates) should play, seen through viewport `v` in a canvas of size `view`. */
export function shouldPlay(box: FrameBox, v: Viewport, view: { width: number; height: number }, playing: boolean): boolean {
  const w = box.w * v.zoom;
  const h = box.h * v.zoom;
  const x = box.x * v.zoom + v.x;
  const y = box.y * v.zoom + v.y;
  if (x >= view.width || y >= view.height || x + w <= 0 || y + h <= 0) return false;
  return w * h >= MOTION_MIN_AREA * (playing ? MOTION_KEEP : 1);
}
