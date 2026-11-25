import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMap, isSeq, LineCounter, parseDocument } from "yaml";
import { CommentStore, unreadIn, type Anchor, type Point, type Thread } from "../core/comments.ts";
import { parseFlow, type Flow, type Issue, type Screen } from "../core/flow.ts";
import { layoutFlow, type Overrides } from "../core/layout.ts";
import { applyPrototype, readPrototype } from "../core/prototype.ts";
import { selectorFor } from "../core/selector.ts";
import { cleanAnchor, inlineScreens } from "../server/server.ts";
import { describeTree, findElement, ownText, visualIssues, type Found, type TreeNode, type VisualIssue } from "./inspect.ts";
import { launchBrowser, screenPage, viewportOf, type Browser, type Clip, type Page } from "./render.ts";
import { UsageError } from "./usage.ts";

/** Where shots and long outlines go by default: the OS temp dir, never the project. */
export const shotsDir = (feature: string) => join(tmpdir(), "design-flow-shots", feature);
/** Outlines longer than this go to a file; this many lines are printed. */
const OUTLINE_MAX = 400;
const VISUAL_LIMITS = { wide: 3, overlap: 5, share: 0.4 };

/** A feature's flow with every screen's HTML in place, as the canvas draws it. */
export interface Feature {
  name: string;
  dir: string;
  flow: Flow;
  flowText: string;
}

export function loadFeature(fd: string, name: string): Feature {
  const file = join(fd, "flow.yaml");
  const flowText = readFileSync(file, "utf8");
  const parsed = parseFlow(flowText, file);
  if (!parsed.flow) throw new Error(`flow.yaml has problems; run design-flow check ${name}`);
  let flow = inlineScreens(parsed.flow, fd, file, [])!;
  const proto = join(fd, "prototype.html");
  if (existsSync(proto)) flow = applyPrototype(flow, readPrototype(readFileSync(proto, "utf8")));
  return { name, dir: fd, flow, flowText };
}

export function screenOf(flow: Flow, id: string | undefined, usage: string): Screen {
  if (!id) throw new UsageError(usage);
  const s = flow.screens.find((x) => x.id === id);
  if (!s) throw new UsageError(`no screen ${id} in flow.yaml; its screens are ${flow.screens.map((x) => x.id).join(", ")}`);
  return s;
}

/** Runs `fn` with one headless browser, and always closes it. */
async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const b = await launchBrowser();
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

/** Renders screen `s`, runs `fn` on the page, closes the page. */
async function onScreen<T>(b: Browser, flow: Flow, s: Screen, scale: number, fn: (p: Page) => Promise<T>): Promise<T> {
  const page = await b.open(screenPage(flow, s), viewportOf(flow, s), scale);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** The element `query` names on screen `s` (a CSS selector or an outline ref); a miss is a usage error. */
async function locate(page: Page, query: string, f: Feature, s: Screen, reveal: boolean): Promise<Found> {
  const r = await page.call(findElement, selectorFor, ownText, describeTree, query, reveal);
  if (!("error" in r)) return r;
  const list = `design-flow outline ${f.name} ${s.id} lists what is on it`;
  if (r.error === "invalid") throw new UsageError(`--element ${query} is not a CSS selector or an outline ref (e12)`);
  if (r.error === "none") throw new UsageError(`nothing on screen ${s.id} matches --element ${query}; ${list}`);
  throw new UsageError(`--element ${query} on screen ${s.id} is hidden or has no size; ${list}`);
}

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "element";

export interface ShotOptions {
  screen?: string;
  all: boolean;
  element?: string;
  scale: number;
  out?: string;
  dir?: string;
}

/** PNGs of screens, in one browser; returns their paths. */
export async function shot(f: Feature, o: ShotOptions, warn: (m: string) => void): Promise<string[]> {
  const usage = "usage: design-flow shot <feature> <screen> [--element <selector>] [--scale 1|2] [--out <file>], or shot <feature> --all [--dir <dir>]";
  if (o.all && (o.screen || o.element || o.out)) throw new UsageError("shot --all takes no screen, --element or --out; it writes <screen>.png for each screen into --dir");
  const screens = o.all ? f.flow.screens : [screenOf(f.flow, o.screen, usage)];
  const dir = o.dir ? resolve(o.dir) : shotsDir(f.name);
  return withBrowser(async (b) => {
    const paths: string[] = [];
    for (const s of screens)
      await onScreen(b, f.flow, s, o.scale, async (page) => {
        let clip: Clip | undefined;
        if (o.element) {
          const found = await locate(page, o.element, f, s, true);
          if (found.count > 1) warn(`--element ${o.element} matches ${found.count} elements on ${s.id}; the shot is of the first, ${found.selector}`);
          clip = padded(found, 8);
          if (clip.width < 1 || clip.height < 1) throw new UsageError(`--element ${o.element} on screen ${s.id} is outside the screen`);
        }
        const file = o.out ? resolve(o.out) : join(dir, `${s.id}${o.element ? `-${slug(o.element)}` : ""}.png`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, await page.screenshot(clip));
        paths.push(file);
      });
    return paths;
  });
}

/** The element's box with `pad` px around it, kept to what the viewport shows, from the top left of the document. */
function padded(found: Found, pad: number): Clip {
  const { box, view, scroll } = found;
  const left = Math.max(0, box.x - pad);
  const top = Math.max(0, box.y - pad);
  const right = Math.min(view.width, box.x + box.width + pad);
  const bottom = Math.min(view.height, box.y + box.height + pad);
  return { x: left + scroll.x, y: top + scroll.y, width: right - left, height: bottom - top };
}

const screenOfAnchor = (a: Anchor) => (a.type === "element" || a.type === "screen" ? a.screen : undefined);

/** The flow as a list, without rendering: viewport, lanes, screens with their threads, edges. */
export function outlineFlow(fd: string, name: string, json: boolean): string {
  const flow = parseFlow(readFileSync(join(fd, "flow.yaml"), "utf8"), "").flow;
  if (!flow) throw new Error(`flow.yaml has problems; run design-flow check ${name}`);
  const threads = CommentStore.load(fd).threads.filter((t) => t.status === "open");
  const counts = (which: (t: Thread) => boolean) => {
    const mine = threads.filter(which);
    return { open: mine.length, unread: mine.filter((t) => unreadIn(t).length).length };
  };
  const vp = (v: { width: number; height: number }) => `${v.width}x${v.height}`;
  const screens = flow.screens.map((s) => ({ id: s.id, title: s.title, lane: s.lane ?? null, viewport: viewportOf(flow, s), ...counts((t) => screenOfAnchor(t.anchor) === s.id) }));
  const elsewhere = counts((t) => !flow.screens.some((s) => s.id === screenOfAnchor(t.anchor)));
  const edges = flow.edges.map((e) => ({ from: e.from, to: e.to, label: e.label ?? null }));
  if (json)
    return JSON.stringify(
      { title: flow.title, viewport: viewportOf(flow), lanes: flow.lanes.map((l) => ({ id: l.id, title: l.title })), screens, edges, otherThreads: elsewhere },
      null,
      2,
    );
  const pad = (rows: string[][]) => {
    const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
    return rows.map((r) => "  " + r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd());
  };
  const threadNote = (c: { open: number; unread: number }) => (c.open ? `${c.open} open${c.unread ? `, ${c.unread} unread` : ""}` : "");
  const lines = [flow.title, `viewport ${vp(viewportOf(flow))}`];
  if (flow.lanes.length) lines.push("lanes", ...pad(flow.lanes.map((l) => [l.id, l.title])));
  lines.push("screens", ...pad(screens.map((s) => [s.id, s.title, s.lane ?? "(no lane)", vp(s.viewport), threadNote(s)])));
  if (edges.length) lines.push("edges", ...pad(edges.map((e) => [`${e.from} → ${e.to}`, e.label ?? ""])));
  if (elsewhere.open) lines.push(`threads on edges, lanes or the canvas: ${threadNote(elsewhere)}`);
  return lines.join("\n");
}

/** One screen's element tree, rendered. Over OUTLINE_MAX lines, the whole outline goes to a file and its start is returned. */
export async function outlineScreen(f: Feature, id: string, json: boolean): Promise<string> {
  const s = screenOf(f.flow, id, "");
  const nodes = await withBrowser((b) => onScreen(b, f.flow, s, 1, (p) => p.call(describeTree, selectorFor, ownText, 60)));
  const vp = viewportOf(f.flow, s);
  if (json) return JSON.stringify({ screen: s.id, title: s.title, viewport: vp, elements: nodes }, null, 2);
  const head = `Screen ${s.id} ${s.title}, ${vp.width}x${vp.height}${s.htmlLine ? "; lines are in prototype.html" : ""}`;
  const lines = nodes.map(treeLine);
  if (lines.length <= OUTLINE_MAX) return [head, ...lines].join("\n");
  const file = join(shotsDir(f.name), `${s.id}.outline.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [head, ...lines].join("\n") + "\n");
  return [head, ...lines.slice(0, OUTLINE_MAX), `… ${lines.length - OUTLINE_MAX} more elements. The whole outline: ${file}`].join("\n");
}

const treeLine = (n: TreeNode) =>
  `${"  ".repeat(n.depth)}${n.ref} ${n.tag}${n.text ? ` ${JSON.stringify(n.text)}` : ""} ${n.box.x},${n.box.y} ${n.box.width}x${n.box.height} ${n.selector}${n.line ? ` line ${n.line}` : ""}`;

/** The line of screen `id`'s entry in flow.yaml. */
function screenLine(text: string, id: string): number {
  const lc = new LineCounter();
  const screens = parseDocument(text, { lineCounter: lc }).get("screens", true);
  if (isSeq(screens)) for (const item of screens.items) if (isMap(item) && item.get("id") === id && item.range) return lc.linePos(item.range[0]).line;
  return 1;
}

/** Renders every screen and returns what looks broken, located in prototype.html, or in flow.yaml for its own screens. */
export async function visualCheck(f: Feature): Promise<Issue[]> {
  return withBrowser(async (b) => {
    const issues: Issue[] = [];
    for (const s of f.flow.screens) {
      const found = await onScreen(b, f.flow, s, 1, (p) => p.call(visualIssues, selectorFor, ownText, VISUAL_LIMITS));
      issues.push(...found.map((v) => visualIssue(f, s, v)));
    }
    return issues;
  });
}

function visualIssue(f: Feature, s: Screen, v: VisualIssue): Issue {
  const where = s.htmlLine
    ? { file: join(f.dir, "prototype.html"), line: v.el.line ?? s.htmlLine }
    : { file: join(f.dir, "flow.yaml"), line: screenLine(f.flowText, s.id) };
  const name = (x: { selector: string; text: string }) => `${x.selector}${x.text ? ` ${JSON.stringify(x.text)}` : ""}`;
  switch (v.kind) {
    case "wide":
      return {
        ...where,
        col: 1,
        message: `${s.id} ${name(v.el)}: wider than the screen, it ends ${v.past} px past the right edge`,
        hint: "Let it shrink or wrap (max-width: 100%, min-width: 0, flex-wrap), or give the screen a wider viewport in flow.yaml.",
      };
    case "cut":
      return {
        ...where,
        col: 1,
        message: `${s.id} ${name(v.el)}: text cut off, it needs ${v.need} px ${v.axis === "x" ? "across" : "down"} and shows ${v.room}`,
        hint: "Give it room, let it wrap, or shorten the copy.",
      };
    case "overlap":
      return {
        ...where,
        col: 1,
        message: `${s.id} ${name(v.el)} and ${name(v.other)}: text overlaps text (${Math.round(v.share * 100)}% of the smaller)`,
        hint: "Move one of them, or give the layout room so neither covers the other.",
      };
  }
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/**
 * Where a point in screen `s`'s own CSS px is on the canvas: the same scaling the canvas uses for a click in a
 * frame (anchorFromFrame in web/src/anchor.ts), from the layout the server sends it. A point below the fold or past
 * the edge is kept to the frame, so the pin stays on the screen it is about.
 */
async function canvasPoint(f: Feature, s: Screen, p: Point): Promise<Point> {
  const vp = viewportOf(f.flow, s);
  const x = Math.min(Math.max(p.x, 0), vp.width);
  const y = Math.min(Math.max(p.y, 0), vp.height);
  const box = (await layoutFlow(f.flow, readJson<Overrides>(join(f.dir, "layout.json"), {}))).screens[s.id];
  if (!box) return { x: Math.round(x), y: Math.round(y) };
  const k = box.w / vp.width;
  return { x: Math.round(box.x + x * k), y: Math.round(box.y + y * k) };
}

/** The anchor of a question the agent asks: on an element of screen `s` when `query` names one, else on the screen. */
export async function askAnchor(f: Feature, s: Screen, query: string | undefined): Promise<{ anchor: Anchor; count: number }> {
  if (!query) return { anchor: { type: "screen", screen: s.id, point: await canvasPoint(f, s, { x: 24, y: 24 }) }, count: 1 };
  const found = await withBrowser((b) => onScreen(b, f.flow, s, 1, (p) => locate(p, query, f, s, false)));
  // In page CSS px, as the canvas records a click: the client rect plus however far the page is scrolled.
  const box = { ...found.box, x: found.box.x + found.scroll.x, y: found.box.y + found.scroll.y };
  const anchor: Anchor = {
    type: "element",
    screen: s.id,
    selector: found.selector,
    tag: found.tag,
    text: found.text,
    point: await canvasPoint(f, s, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    box,
    offset: { x: 0.5, y: 0.5 },
    ...(found.near ? { near: found.near } : {}),
    ...(found.line ? { line: found.line } : {}),
  };
  // The same check the server gives a comment from the canvas.
  const clean = cleanAnchor(anchor);
  if (!clean) throw new UsageError(`the element's selector is too long to anchor on (${found.selector.length} characters); give it a data-id`);
  return { anchor: clean, count: found.count };
}
