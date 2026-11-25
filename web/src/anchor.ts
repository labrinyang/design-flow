import type { Anchor, Point } from "../../src/core/comments.ts";
import type { Flow } from "../../src/core/flow.ts";
import type { Locale } from "./i18n.ts";


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

/** What a frame reports about a clicked element. */
export interface FrameElement {
  selector: string;
  tag: string;
  text: string;
  box?: { x: number; y: number; width: number; height: number };
  offset?: Point;
  near?: string;
  line?: number;
}

/**
 * The anchor for a commenting click inside a screen frame, in flow coordinates. A frame counts lines from its
 * prototype section's first line; `htmlLine` is where that section starts in prototype.html.
 */
export function anchorFromFrame(
  click: { screen: string; x: number; y: number; element: FrameElement | null },
  box: { x: number; y: number; w: number },
  viewportWidth: number,
  htmlLine?: number,
): Anchor {
  const s = box.w / viewportWidth;
  const point = { x: Math.round(box.x + click.x * s), y: Math.round(box.y + click.y * s) };
  const el = click.element;
  if (!el) return { type: "screen", screen: click.screen, point };
  return {
    type: "element",
    screen: click.screen,
    selector: el.selector,
    tag: el.tag,
    text: el.text,
    point,
    ...(el.box ? { box: el.box } : {}),
    ...(el.offset ? { offset: el.offset } : {}),
    ...(el.near ? { near: el.near } : {}),
    ...(el.line && htmlLine ? { line: htmlLine + el.line - 1 } : {}),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where an element comment's pin goes once its frame has said where the element is now (`at`, in the
 * frame's CSS px, relative to what the frame shows): the same spot in the element as the click, kept
 * inside the frame. Anchors from before the click spot was kept use the stored point's spot.
 */
export function pinOnElement(
  anchor: Extract<Anchor, { type: "element" }>,
  at: { x: number; y: number; width: number; height: number },
  frame: { x: number; y: number; w: number; h: number },
  viewportWidth: number,
): Point {
  const s = frame.w / viewportWidth;
  const off = anchor.offset ?? {
    x: at.width > 0 ? clamp(((anchor.point.x - frame.x) / s - at.x) / at.width, 0, 1) : 0.5,
    y: at.height > 0 ? clamp(((anchor.point.y - frame.y) / s - at.y) / at.height, 0, 1) : 0.5,
  };
  return {
    x: Math.round(clamp(frame.x + (at.x + off.x * at.width) * s, frame.x, frame.x + frame.w)),
    y: Math.round(clamp(frame.y + (at.y + off.y * at.height) * s, frame.y, frame.y + frame.h)),
  };
}

/** A comment's place, in words for people: what it is on (title), and the part of it (detail). The ids go in the tip. */
export interface AnchorTitle {
  title: string;
  detail?: string;
  tip: string;
}

const TAG_WORDS: Record<Locale, Record<string, string>> = {
  zh: { button: "按钮", a: "链接", input: "输入框", textarea: "输入框", select: "选择框", img: "图片", svg: "图标", video: "视频", label: "标签", li: "列表项", h1: "标题", h2: "标题", h3: "标题", h4: "标题", h5: "标题", h6: "标题" },
  en: { button: "Button", a: "Link", input: "Field", textarea: "Field", select: "Picker", img: "Image", svg: "Icon", video: "Video", label: "Label", li: "List item", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading" },
};

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "按钮“确认支付”", "“¥ 12.00”", "图片"; "Button "Pay"". */
export function elementPhrase(tag: string, text: string, locale: Locale): string {
  const word = TAG_WORDS[locale][tag.toLowerCase()];
  const t = text.trim() ? short(text.replace(/\s+/g, " ").trim(), 24) : "";
  const quoted = t ? (locale === "zh" ? `“${t}”` : `"${t}"`) : "";
  if (word && quoted) return locale === "zh" ? `${word}${quoted}` : `${word} ${quoted}`;
  return quoted || word || (locale === "zh" ? "元素" : "Element");
}

export function anchorTitle(a: Anchor, flow: Flow | undefined, locale: Locale): AnchorTitle {
  const zh = locale === "zh";
  const removed = zh ? "（已删除）" : " (removed)";
  const screenTitle = (id: string) => {
    const s = flow?.screens.find((x) => x.id === id);
    return s ? s.title || s.id : `${id}${removed}`;
  };
  const screenTip = (id: string) => (zh ? `帧 ${id}` : `Screen ${id}`);
  switch (a.type) {
    case "element":
      return { title: screenTitle(a.screen), detail: elementPhrase(a.tag, a.text, locale), tip: `${screenTip(a.screen)}${zh ? "，" : ", "}${a.selector}` };
    case "screen":
      return { title: screenTitle(a.screen), tip: screenTip(a.screen) };
    case "edge": {
      const e = flow?.edges.find((x) => x.from === a.edge.from && x.to === a.edge.to);
      return {
        title: `${screenTitle(a.edge.from)} → ${screenTitle(a.edge.to)}`,
        detail: e?.label ? (zh ? `“${e.label}”` : `"${e.label}"`) : zh ? "连线" : "Arrow",
        tip: `${zh ? "连线" : "Arrow"} ${a.edge.from} → ${a.edge.to}`,
      };
    }
    case "lane": {
      const l = flow?.lanes.find((x) => x.id === a.lane);
      return { title: l ? l.title : `${a.lane}${removed}`, detail: zh ? "泳道" : "Lane", tip: `${zh ? "泳道" : "Lane"} ${a.lane}` };
    }
    case "canvas":
      return {
        title: zh ? "画布空白处" : "Canvas",
        ...(a.near ? { detail: zh ? `靠近${screenTitle(a.near)}` : `near ${screenTitle(a.near)}` } : {}),
        tip: a.near ? screenTip(a.near) : zh ? "画布" : "Canvas",
      };
  }
}

export function exportBounds(boxes: { x: number; y: number; width: number; height: number }[], pad: number) {
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad;
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad;
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
