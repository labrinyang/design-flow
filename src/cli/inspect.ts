// Functions that run inside a rendered screen, through Page.call in render.ts. Each is sent as its own source, so it
// may use nothing from outside itself: what it needs, selectorFor and the helpers below included, comes in as an argument.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
type SelectorFor = (el: Element, body: Element) => string;
type OwnText = (el: Element) => string;

/** What an element says itself: its own text, else its value or placeholder, aria-label or alt; whitespace collapsed. */
export function ownText(el: Element): string {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  let t = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += " " + (n.textContent ?? "");
  if (squash(t)) return squash(t);
  const field = el as HTMLInputElement;
  const valued = el.localName === "textarea" || (el.localName === "input" && !/^(checkbox|radio|hidden|range|color|file|image)$/i.test(field.type));
  if (valued) t = field.value || field.placeholder || "";
  else if (el.localName === "select") t = (el as HTMLSelectElement).selectedOptions[0]?.text ?? "";
  return squash(t || el.getAttribute("aria-label") || el.getAttribute("alt") || "");
}

/** One line of the outline. */
export interface TreeNode {
  ref: string;
  depth: number;
  tag: string;
  text: string;
  /** In page CSS px: the client rect plus the scroll. */
  box: Box;
  selector: string;
  /** The prototype.html line its tag starts on. */
  line?: number;
}

/**
 * The screen's elements as the outline lists them, in document order: the visible ones with a size, where a wrapper
 * that says nothing and holds one element gives way to that element, and an empty box that shows nothing is left out.
 * Content cut off by overflow: hidden is left out; content a scroll area holds is not. `keep` receives the elements
 * in the same order.
 */
export function describeTree(selectorFor: SelectorFor, ownText: OwnText, textMax: number, keep: Element[] = []): TreeNode[] {
  type Clip = { left: number; top: number; right: number; bottom: number };
  type Item = { el: Element; text: string; r: DOMRect; children: Item[] };
  const SKIP = new Set(["script", "style", "template", "noscript", "meta", "link", "title", "head", "base"]);
  const LEAF = new Set(["svg", "math", "img", "picture", "video", "audio", "canvas", "iframe", "object", "embed", "input", "select", "textarea"]);
  const ACTIVE = "a[href],button,input,select,textarea,label,summary,[role],[tabindex],[onclick],[contenteditable],[data-id],[data-to],[data-back]";
  const cut = (c: Clip | null, r: DOMRect, s: CSSStyleDeclaration): Clip | null => {
    const x = /hidden|clip/.test(s.overflowX);
    const y = /hidden|clip/.test(s.overflowY);
    if (!x && !y) return c;
    const b = c ?? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    return {
      left: x ? Math.max(b.left, r.left) : b.left,
      right: x ? Math.min(b.right, r.right) : b.right,
      top: y ? Math.max(b.top, r.top) : b.top,
      bottom: y ? Math.min(b.bottom, r.bottom) : b.bottom,
    };
  };
  const meets = (c: Clip | null, r: DOMRect) => !c || (r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom);
  // Whether an element shows anything of its own: a fill, a border, a shadow, or ::before or ::after content.
  const paints = (el: Element, s: CSSStyleDeclaration) =>
    !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.backgroundColor) ||
    s.backgroundImage !== "none" ||
    s.boxShadow !== "none" ||
    [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].some((w) => parseFloat(w) > 0) ||
    ["::before", "::after"].some((p) => !/^(none|normal)$/.test(getComputedStyle(el, p).content));
  const walk = (el: Element, clip: Clip | null, root: boolean): Item[] => {
    if (SKIP.has(el.localName)) return [];
    const s = getComputedStyle(el);
    if (s.display === "contents") return Array.from(el.children).flatMap((c) => walk(c, clip, root));
    if (s.display === "none" || s.opacity === "0" || !el.getClientRects().length) return [];
    const r = el.getBoundingClientRect();
    const children = LEAF.has(el.localName) ? [] : Array.from(el.children).flatMap((c) => walk(c, cut(clip, r, s), false));
    if (s.visibility !== "visible" || r.width < 1 || r.height < 1 || !meets(clip, r)) return children;
    const text = ownText(el);
    const active = el.matches(ACTIVE);
    if (!root && !text && children.length === 1 && !active) return children;
    // An empty box that shows nothing, such as a spacer, is layout, not content.
    if (!root && !text && !children.length && !active && !LEAF.has(el.localName) && !paints(el, s)) return [];
    return [{ el, text, r, children }];
  };
  const out: TreeNode[] = [];
  const flat = (items: Item[], depth: number) => {
    for (const { el, text, r, children } of items) {
      keep.push(el);
      const line = Number(el.getAttribute("data-df-line"));
      out.push({
        ref: `e${out.length + 1}`,
        depth,
        tag: el.localName,
        text: text.length > textMax ? text.slice(0, textMax - 1) + "…" : text,
        // In page px, as anchors are: the client rect plus the scroll.
        box: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
        selector: selectorFor(el, document.body),
        ...(line ? { line } : {}),
      });
      flat(children, depth + 1);
    }
  };
  flat(
    Array.from(document.body.children).flatMap((el) => walk(el, null, true)),
    0,
  );
  return out;
}

/** An element found by --element, as a comment anchor or a screenshot clip needs it. */
export interface Found {
  /** How many elements matched; the first is the one described. */
  count: number;
  selector: string;
  tag: string;
  text: string;
  /** In CSS px from the top left of the viewport. */
  box: Box;
  line?: number;
  near?: string;
  view: { width: number; height: number };
  scroll: { x: number; y: number };
}

/**
 * The first element that `query` names: an outline ref such as e12, else a CSS selector. `reveal` scrolls it into
 * view first. near is the text of the closest ancestor that says more than the element, cut to 120 characters
 * around the element's own text.
 */
export function findElement(
  selectorFor: SelectorFor,
  ownText: OwnText,
  tree: typeof describeTree,
  query: string,
  reveal: boolean,
): Found | { error: "invalid" | "none" | "hidden" } {
  let el: Element | undefined;
  let count = 0;
  if (/^e\d+$/.test(query)) {
    const keep: Element[] = [];
    tree(selectorFor, ownText, 60, keep);
    el = keep[Number(query.slice(1)) - 1];
    count = el ? 1 : 0;
  }
  if (!el) {
    try {
      const all = document.body.querySelectorAll(query);
      count = all.length;
      el = all[0];
    } catch {
      return { error: "invalid" };
    }
  }
  if (!el) return { error: "none" };
  if (reveal) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility !== "visible") return { error: "hidden" };
  const label = (e: Element) => ((e as HTMLElement).innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
  const text = label(el);
  let near = "";
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const t = label(p);
    if (t.length > text.length) {
      near = t;
      break;
    }
  }
  if (near.length > 120) {
    const at = Math.max(0, near.indexOf(text));
    const from = Math.max(0, Math.min(at - Math.floor((120 - text.length) / 2), near.length - 120));
    near = near.slice(from, from + 120);
  }
  const line = Number(el.closest("[data-df-line]")?.getAttribute("data-df-line"));
  return {
    count,
    selector: selectorFor(el, document.body),
    tag: el.localName,
    text: text.slice(0, 80),
    box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    ...(line ? { line } : {}),
    ...(near ? { near } : {}),
    view: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
  };
}

/** An element a visual issue is about. */
export interface Spot {
  selector: string;
  tag: string;
  text: string;
  line?: number;
}
export type VisualIssue =
  /** Sticks out `past` px past the screen's right edge. */
  | { kind: "wide"; el: Spot; past: number }
  /** Its text needs `need` px across (axis x) or down (y) and the box shows `room`. */
  | { kind: "cut"; el: Spot; axis: "x" | "y"; need: number; room: number }
  /** Its text and other's overlap by `share` (0 to 1) of the smaller one. */
  | { kind: "overlap"; el: Spot; other: Spot; share: number };

/**
 * What looks broken on the screen: content past its right edge (the outermost elements that stick out, up to
 * limits.wide), text cut off by overflow or an ellipsis, and text over other text (up to limits.overlap pairs that
 * share at least limits.share of the smaller text). Text hidden under an opaque layer, such as a dialog over the page
 * or a badge, does not count as overlapping.
 */
export function visualIssues(selectorFor: SelectorFor, ownText: OwnText, limits: { wide: number; overlap: number; share: number }): VisualIssue[] {
  type Clip = { left: number; top: number; right: number; bottom: number };
  type Text = { el: Element; rects: DOMRect[]; area: number; fixed: boolean };
  const SKIP = new Set(["script", "style", "template", "noscript", "meta", "link", "title", "head", "base"]);
  const body = document.body;
  const edge = document.documentElement.clientWidth;
  const spot = (el: Element): Spot => {
    const t = ownText(el);
    const line = Number(el.closest("[data-df-line]")?.getAttribute("data-df-line"));
    return { selector: selectorFor(el, body), tag: el.localName, text: t.length > 40 ? t.slice(0, 39) + "…" : t, ...(line ? { line } : {}) };
  };
  // Anything a box does not show, scrolled or clipped, is out of sight here.
  const cut = (c: Clip | null, r: DOMRect, s: CSSStyleDeclaration): Clip | null => {
    const x = s.overflowX !== "visible";
    const y = s.overflowY !== "visible";
    if (!x && !y) return c;
    const b = c ?? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    return {
      left: x ? Math.max(b.left, r.left) : b.left,
      right: x ? Math.min(b.right, r.right) : b.right,
      top: y ? Math.max(b.top, r.top) : b.top,
      bottom: y ? Math.min(b.bottom, r.bottom) : b.bottom,
    };
  };
  const within = (q: DOMRect, c: Clip | null): DOMRect | null => {
    if (!c) return q;
    const left = Math.max(q.left, c.left);
    const top = Math.max(q.top, c.top);
    const right = Math.min(q.right, c.right);
    const bottom = Math.min(q.bottom, c.bottom);
    return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
  };
  const textRects = (el: Element, clip: Clip | null): DOMRect[] => {
    const rects: DOMRect[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const q of Array.from(range.getClientRects())) {
        const v = within(q, clip);
        if (v && v.width >= 1 && v.height >= 1) rects.push(v);
      }
    }
    return rects;
  };
  // Measured from the top, where client rects are page px, whatever the screen's own scripts scrolled to.
  scrollTo(0, 0);
  const issues: VisualIssue[] = [];
  const texts: Text[] = [];
  let wide = 0;
  const hides = (v: string) => v === "hidden" || v === "clip";
  const walk = (el: Element, clip: Clip | null, fixed: boolean, outside: boolean) => {
    if (SKIP.has(el.localName)) return;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.opacity === "0") return;
    const contents = s.display === "contents";
    if (!contents && !el.getClientRects().length) return;
    const r = el.getBoundingClientRect();
    const isFixed = fixed || s.position === "fixed";
    // What the element shows of its own text and children: its own overflow cuts them too.
    const inner = contents ? clip : cut(clip, r, s);
    let past = false;
    if (!contents && s.visibility === "visible" && r.width >= 1 && r.height >= 1) {
      const rects = textRects(el, inner);
      const right = Math.min(Math.max(r.right, ...rects.map((q) => q.right)), clip ? clip.right : Infinity);
      past = right > edge + 1;
      if (past && !outside && wide < limits.wide) {
        wide++;
        issues.push({ kind: "wide", el: spot(el), past: Math.round(right - edge) });
      }
      if (rects.length) {
        const x = el.scrollWidth - el.clientWidth > 1 && (hides(s.overflowX) || s.textOverflow === "ellipsis");
        const y = el.scrollHeight - el.clientHeight > 1 && hides(s.overflowY);
        if (x) issues.push({ kind: "cut", el: spot(el), axis: "x", need: el.scrollWidth, room: el.clientWidth });
        else if (y) issues.push({ kind: "cut", el: spot(el), axis: "y", need: el.scrollHeight, room: el.clientHeight });
        texts.push({ el, rects, area: rects.reduce((sum, q) => sum + q.width * q.height, 0), fixed: isFixed });
      }
    }
    if (el.localName === "svg" || el.localName === "math") return;
    for (const c of Array.from(el.children)) walk(c, inner, isFixed, outside || past);
  };
  for (const c of Array.from(body.children)) walk(c, null, false, false);

  const alpha = (c: string) => {
    if (c === "transparent") return 0;
    const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c) ?? /^rgba\((?:[^,]*,){3}\s*([\d.]+)(%?)\s*\)$/.exec(c);
    return m ? Number(m[1]) / (m[2] ? 100 : 1) : 1;
  };
  const opaque = (el: Element) => {
    const s = getComputedStyle(el);
    return alpha(s.backgroundColor) >= 0.5 || s.backgroundImage !== "none" || (s.backdropFilter || "none") !== "none";
  };
  // Painted in a layer above normal text: positioned, or a stacking context, up to where it meets `below`.
  const layered = (el: Element, below: Element) => {
    for (let p: Element | null = el; p && !p.contains(below); p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.position !== "static" || s.transform !== "none" || Number(s.opacity) < 1 || s.filter !== "none") return true;
    }
    return false;
  };
  const covered = (a: Text, b: Text, x: number, y: number) => {
    let vx = x;
    let vy = y;
    // Fixed text is in view as the page first shows; other text may be further down, so scroll there to look.
    if (!a.fixed && !b.fixed && (y < 0 || y >= innerHeight)) {
      scrollTo(0, Math.max(0, y - innerHeight / 2));
      vx = x - scrollX;
      vy = y - scrollY;
    } else if (scrollY) scrollTo(0, 0);
    const stack = document.elementsFromPoint(vx, vy);
    const ia = stack.indexOf(a.el);
    const ib = stack.indexOf(b.el);
    if (ia < 0 || ib < 0) return false;
    const lower = stack[Math.max(ia, ib)];
    return stack.slice(Math.min(ia, ib), Math.max(ia, ib)).some((c) => !c.contains(lower) && opaque(c) && layered(c, lower));
  };
  let overlaps = 0;
  for (let i = 0; i < texts.length && overlaps < limits.overlap; i++)
    for (let j = i + 1; j < texts.length && overlaps < limits.overlap; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      let shared = 0;
      let most = 0;
      let at = { x: 0, y: 0 };
      for (const p of a.rects)
        for (const q of b.rects) {
          const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          if (w <= 0 || h <= 0) continue;
          shared += w * h;
          if (w * h > most) {
            most = w * h;
            at = { x: Math.max(p.left, q.left) + w / 2, y: Math.max(p.top, q.top) + h / 2 };
          }
        }
      const smaller = Math.min(a.area, b.area);
      if (!shared || shared < limits.share * smaller || covered(a, b, at.x, at.y)) continue;
      overlaps++;
      issues.push({ kind: "overlap", el: spot(a.el), other: spot(b.el), share: Math.min(1, shared / smaller) });
    }
  scrollTo(0, 0);
  return issues;
}
