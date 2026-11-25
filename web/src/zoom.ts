import type { Flow } from "../../src/core/flow.ts";
import type { Layout } from "../../src/core/layout.ts";
import { viewportOf } from "./screen-doc.ts";

/** How far the canvas zooms out and in. At 8×, a phone frame is drawn at about 3.7× its CSS size. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Fit to window stops here, as it did when this was the zoom limit, so one or two screens are not blown up to fill the window. */
export const FIT_MAX_ZOOM = 2.5;
/** One press of + or − zooms by this factor (React Flow's own step), and no single wheel event zooms more. */
export const ZOOM_STEP = 1.2;

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Scale for chrome drawn inside the zoomed canvas (comment outlines): it follows the
 * zoom up to 100%, then keeps its 100% size instead of growing with the screens.
 */
export const chromeScale = (zoom: number) => Math.min(zoom, 1) / zoom;

/** A comment pin is 28px at 100%; on screen it stays between 22px, so its number reads when zoomed out, and 28px. */
export const PIN_PX = 28;
export const PIN_MIN_PX = 22;
export const pinScale = (zoom: number) => Math.min(Math.max(zoom, PIN_MIN_PX / PIN_PX), 1) / zoom;

/**
 * Screen labels and lane titles stop shrinking with the canvas at a readable size, as pins do. A screen's
 * label keeps its 100% size on screen below 100% (12px for the id); a lane title shrinks from 18px to 14px, then holds.
 */
export const labelScale = (zoom: number) => Math.max(1, 1 / zoom);
export const LANE_TITLE_PX = 18;
export const LANE_TITLE_MIN_PX = 14;
export const laneTitleScale = (zoom: number) => Math.max(1, LANE_TITLE_MIN_PX / (LANE_TITLE_PX * zoom));
/** Below this zoom a screen's id and title share one line, so the label does not reach up into the row above. */
export const COMPACT_LABEL_ZOOM = 0.6;

/**
 * log2 of the zoom change for one wheel event with Ctrl or ⌘ held; a trackpad pinch arrives as Ctrl + wheel.
 * Ctrl and ⌘ zoom alike, and no single event zooms more than one press of +.
 */
export function wheelZoomStep(deltaY: number, deltaMode: number, mac: boolean): number {
  const perUnit = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
  // macOS sends a few pixels per wheel tick and per pinch event alike; React Flow scales its pinches by 10 there too.
  const step = -deltaY * perUnit * (mac ? 10 : 1);
  const max = Math.log2(ZOOM_STEP);
  return Math.max(-max, Math.min(max, step));
}

/** The viewport after zooming by 2^step around a point given in canvas pixels, within the zoom limits. */
export function zoomAround(v: Viewport, p: { x: number; y: number }, step: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * 2 ** step));
  const k = zoom / v.zoom;
  return { x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k, zoom };
}

/** Pixels taken from each side of the canvas: a margin, plus the toolbar and the comment panel where they float. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The viewport that shows `bounds` (flow coordinates) whole, centred in the part of the canvas the insets leave free. */
export function fitViewport(
  bounds: { x: number; y: number; width: number; height: number },
  canvas: { width: number; height: number },
  insets: Insets,
  maxZoom = FIT_MAX_ZOOM,
): Viewport {
  const w = Math.max(1, canvas.width - insets.left - insets.right);
  const h = Math.max(1, canvas.height - insets.top - insets.bottom);
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min(w / Math.max(1, bounds.width), h / Math.max(1, bounds.height))));
  return {
    x: insets.left + (w - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: insets.top + (h - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/**
 * The zoom that shows one frame (with its label) comfortably: most of the canvas's height and no more than
 * most of its width, and never past the screen's real size.
 */
export function focusZoom(box: { w: number; h: number }, canvas: { width: number; height: number }, realSize: number): number {
  const zoom = Math.min((canvas.width * 0.6) / Math.max(1, box.w), (canvas.height * 0.8) / Math.max(1, box.h), realSize);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The zoom at which screens show at their real CSS size. Frames of different viewports are drawn at
 * different scales, so it is that of the screen nearest `center` (flow coordinates).
 */
export function actualSizeZoom(flow: Flow, layout: Layout, center: { x: number; y: number }): number {
  let best: { d: number; zoom: number } | undefined;
  for (const s of flow.screens) {
    const b = layout.screens[s.id];
    if (!b) continue;
    const d = Math.hypot(b.x + b.w / 2 - center.x, b.y + b.h / 2 - center.y);
    if (!best || d < best.d) best = { d, zoom: viewportOf(flow, s).width / b.w };
  }
  return Math.min(MAX_ZOOM, best?.zoom ?? 1);
}
