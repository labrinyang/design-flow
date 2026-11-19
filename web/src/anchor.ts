import type { Anchor, Point } from "../../src/core/comments.ts";


interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}

export function nearestScreen(p: Point, screens: Record<string, { x: number; y: number; w?: number; h?: number }>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const [id, s] of Object.entries(screens)) {
    const d = Math.hypot(s.x + (s.w ?? 180) / 2 - p.x, s.y + (s.h ?? 390) / 2 - p.y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** The anchor for a click on `target` at flow coordinates `point`. */
export function anchorFromTarget(
  target: ElementLike | null,
  point: Point,
  screens: Record<string, { x: number; y: number }>,
): Anchor {
  const hit = target?.closest("[data-anchor]");
  const get = (k: string) => hit?.getAttribute(k) ?? "";
  switch (hit?.getAttribute("data-anchor")) {
    case "screen":
      return { type: "screen", screen: get("data-screen"), point };
    case "edge":
      return {
        type: "edge",
        edge: { from: get("data-from"), to: get("data-to"), ...(/^\d+$/.test(get("data-index")) ? { index: Number(get("data-index")) } : {}) },
        point,
      };
    case "lane":
      return { type: "lane", lane: get("data-lane"), point };
  }
  const near = nearestScreen(point, screens);
  return near ? { type: "canvas", point, near } : { type: "canvas", point };
}

/** The anchor for a commenting click inside a screen frame, in flow coordinates. */
export function anchorFromFrame(
  click: { screen: string; x: number; y: number; element: { selector: string; tag: string; text: string } | null },
  box: { x: number; y: number; w: number },
  viewportWidth: number,
): Anchor {
  const s = box.w / viewportWidth;
  const point = { x: Math.round(box.x + click.x * s), y: Math.round(box.y + click.y * s) };
  return click.element
    ? { type: "element", screen: click.screen, selector: click.element.selector, tag: click.element.tag, text: click.element.text, point }
    : { type: "screen", screen: click.screen, point };
}

export function exportBounds(boxes: { x: number; y: number; width: number; height: number }[], pad: number) {
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad;
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad;
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
