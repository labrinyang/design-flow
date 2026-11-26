import { Menu, MenuItem, MenuPopup, MenuTrigger, Tooltip } from "@astrafoundry/design/ui";
import { Handle, Position, useViewportStore, type NodeProps } from "@xyflow/react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Focus, MessageSquare } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Flow, Lane, Screen } from "../../src/core/flow.ts";
import { t } from "./i18n.ts";
import { LABEL_H, NOTE_H, type LaneNode, type LinkEnd, type ScreenNode } from "./model.ts";
import type { FrameElement } from "./anchor.ts";
import { acceptFrameLocated, acceptFrameMessage, acceptFrameWheel, frameToClient, screenDocument, viewportOf, type FrameWheelData, type Located } from "./screen-doc.ts";
import { FAR_FRAME_PX } from "./zoom.ts";

export interface FrameClick {
  screen: string;
  /** Viewport (CSS px inside the frame) of the click. */
  x: number;
  y: number;
  element: FrameElement | null;
}

/** Where commented elements are in one screen's frame now. */
export interface FrameLocated {
  screen: string;
  items: Located[];
}

/** What nodes ask of the canvas. */
export interface CanvasActionHandlers {
  toggleLane(lane: string): void;
  /** Collapse every other lane, open this one, and show it. */
  onlyLane(lane: string): void;
  /** The pointer came onto a screen while commenting, so it should be a live frame to click into. */
  hoverScreen(screen: string): void;
  /** The pointer came onto a screen, or left it (no screen): the screen under it shows its lines. */
  pointScreen(screen: string | undefined): void;
  /** A click on a screen keeps its lines shown until a click elsewhere, or lets them go. */
  holdScreen(screen: string): void;
  /** Go to the screen at the other end of a link. */
  goToScreen(screen: string): void;
}
export const CanvasActions = createContext<CanvasActionHandlers>({
  toggleLane() {},
  onlyLane() {},
  hoverScreen() {},
  pointScreen() {},
  holdScreen() {},
  goToScreen() {},
});

/** Reports from every frame go through one listener on the canvas: "comment" (a commenting click) and "located". */
export const frameEvents = new EventTarget();
interface FrameEntry {
  screen: string;
  window: () => Window | null | undefined;
  element: () => HTMLIFrameElement | null;
  /** Its page is in, so messages to it are heard. */
  loaded: boolean;
}
const frames = new Map<string, FrameEntry>();

if (typeof window !== "undefined")
  window.addEventListener("message", (e) => {
    const click = acceptFrameMessage(e, frames);
    if (click) return void frameEvents.dispatchEvent(new CustomEvent<FrameClick>("comment", { detail: click }));
    const located = acceptFrameLocated(e, frames);
    if (located) return void frameEvents.dispatchEvent(new CustomEvent<FrameLocated>("located", { detail: located }));
    const wheel = acceptFrameWheel(e, frames);
    if (wheel) replayWheel(wheel);
  });

/**
 * What the canvas has asked of each screen's frame, kept so a frame that loads again (after an edit, or when its
 * screen comes back into view as a live frame) is told again: whether its motion is paused, which commented
 * elements to report on, what to ring, and a flash asked for before it was there.
 */
const paused = new Set<string>();
const asked = new Map<string, { id: string; selector: string }[]>();
let ringed: { screen: string; selector: string } | undefined;
const flashes = new Map<string, { selector: string; at: number }>();
/** A flash still shows if the frame loads this soon after it was asked for. */
const FLASH_WAIT_MS = 4000;

function postTo(screen: string, message: Record<string, unknown>) {
  for (const [channel, f] of frames) if (f.screen === screen) f.window()?.postMessage({ channel, ...message }, "*");
}

/** Play or pause a screen's animations. */
export function setFrameMotion(screen: string, on: boolean) {
  if (on !== paused.has(screen)) return;
  if (on) paused.delete(screen);
  else paused.add(screen);
  postTo(screen, { type: "motion", on });
}

/** Ask each screen's frame where these elements are; frames answer now and whenever their page changes. */
export function locateInFrames(items: Map<string, { id: string; selector: string }[]>) {
  for (const screen of new Set([...asked.keys(), ...items.keys()])) {
    const next = items.get(screen) ?? [];
    if (JSON.stringify(next) === JSON.stringify(asked.get(screen) ?? [])) continue;
    if (next.length) asked.set(screen, next);
    else asked.delete(screen);
    postTo(screen, { type: "locate", items: next });
  }
}

/** Ring one element in a screen's frame for a moment; a screen shown as a picture flashes once its frame is in. */
export function flashInFrame(screen: string, selector: string) {
  let shown = false;
  for (const [channel, f] of frames)
    if (f.screen === screen && f.loaded) {
      f.window()?.postMessage({ channel, type: "flash", selector }, "*");
      shown = true;
    }
  if (shown) flashes.delete(screen);
  else flashes.set(screen, { selector, at: Date.now() });
}

/**
 * Replay a wheel or pinch from inside a frame on the frame's box, at the same spot on the page.
 * React Flow then pans or zooms exactly as it does over a frame when not commenting.
 */
function replayWheel(w: FrameWheelData) {
  const iframe = frames.get(w.channel)?.element();
  const box = iframe?.parentElement;
  if (!iframe || !box) return;
  const at = frameToClient(w, iframe.getBoundingClientRect(), iframe.offsetWidth);
  box.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      deltaX: w.deltaX,
      deltaY: w.deltaY,
      deltaMode: w.deltaMode,
      ctrlKey: w.ctrlKey,
      metaKey: w.metaKey,
      shiftKey: w.shiftKey,
      altKey: w.altKey,
    }),
  );
}

/** Ring one element inside a screen's frame (or clear every frame's ring with no screen). */
export function highlightInFrame(screen: string | undefined, selector: string | undefined) {
  ringed = screen && selector ? { screen, selector } : undefined;
  for (const [channel, f] of frames)
    f.window()?.postMessage({ channel, type: "highlight", selector: f.screen === screen ? (selector ?? null) : null }, "*");
}

/**
 * A screen on the canvas: its picture, with a live frame over it while the canvas shows it close enough to read
 * (live.ts). Far out, its label and note are left out.
 */
export function ScreenNodeView({ data }: NodeProps<ScreenNode>) {
  const { screen, tone, flow, commenting, live, thumb, out, into } = data;
  const w = data.width;
  const h = data.height;
  const far = useViewportStore((s) => s.transform[2] * w < FAR_FRAME_PX);
  const actions = useContext(CanvasActions);
  return (
    <div
      data-tone={tone}
      className="relative"
      style={{ width: w, height: h }}
      // Not while a button is held: the canvas is being dragged across the screen.
      onPointerEnter={(e) => e.buttons === 0 && actions.pointScreen(screen.id)}
      onPointerLeave={() => actions.pointScreen(undefined)}
      onClick={commenting ? undefined : () => actions.holdScreen(screen.id)}
    >
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <Handle id="out-right" type="source" position={Position.Right} />
      <Handle id="out-left" type="source" position={Position.Left} />
      {!far && (
        <div
          data-anchor="screen"
          data-screen={screen.id}
          data-df-label
          className="absolute bottom-full left-0 flex flex-col justify-end pb-1.5 text-[14px] leading-tight"
          style={{ height: LABEL_H, "--w": `${w}px` } as CSSProperties}
        >
          <div data-df-label-top className="flex min-w-0 items-center gap-2">
            <span data-id className="shrink-0 text-[12px] font-medium tracking-wide tabular-nums" style={{ color: "var(--tone)" }}>
              {screen.id}
            </span>
            {(out.length > 0 || into.length > 0) && <LinkChips out={out} into={into} />}
          </div>
          <span data-title className="min-w-0 truncate text-foreground">
            {screen.title}
          </span>
        </div>
      )}
      <div
        data-anchor="screen"
        data-screen={screen.id}
        data-frame
        className="relative h-full overflow-hidden rounded-xl shadow-2 ring-1 ring-border"
        style={{ background: "white" }}
        onPointerEnter={commenting ? () => actions.hoverScreen(screen.id) : undefined}
      >
        {thumb && (
          <img src={thumb} alt={`${screen.id} ${screen.title}`} draggable={false} decoding="async" className="pointer-events-none absolute inset-0 size-full select-none" />
        )}
        {live && <LiveFrame flow={flow} screen={screen} width={w} commenting={commenting} />}
        {!far && screen.badges.length > 0 && (
          <div className="pointer-events-none absolute right-2 bottom-2 flex gap-1">
            {screen.badges.map((b) => (
              <span key={b} className="rounded-full bg-substrate px-2 py-0.5 text-[10px] text-substrate-hi">
                {t.badge[b]}
              </span>
            ))}
          </div>
        )}
      </div>
      {!far && screen.note && (
        <div
          className="absolute inset-x-0 pt-2 text-[12px] leading-snug text-pretty text-muted-foreground"
          style={{ top: h, height: NOTE_H }}
        >
          {screen.note}
        </div>
      )}
    </div>
  );
}

const CHIP =
  "nodrag nopan flex h-[18px] min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-card px-1.5 text-[11px] leading-none font-normal tracking-normal text-muted-foreground ring-1 ring-border hover:text-foreground hover:ring-foreground/40";

/**
 * Where a screen leads in other lanes and where it is reached from, on its label instead of long lines: one chip
 * per screen it leads to (named when it is the only one), and a chip with a list for four or more, or for more
 * than one screen it is reached from. A click goes there.
 */
function LinkChips({ out, into }: { out: LinkEnd[]; into: LinkEnd[] }) {
  return (
    <span data-df-chips className="ml-auto flex min-w-0 items-center gap-1">
      {into.length === 1 && <LinkChip dir="in" end={into[0]} named={false} />}
      {into.length > 1 && <LinkList dir="in" ends={into} />}
      {out.length <= 3 && out.map((e) => <LinkChip key={e.id} dir="out" end={e} named={out.length === 1} />)}
      {out.length > 3 && <LinkList dir="out" ends={out} />}
    </span>
  );
}

function LinkChip({ dir, end, named }: { dir: "in" | "out"; end: LinkEnd; named: boolean }) {
  const actions = useContext(CanvasActions);
  const tip = dir === "out" ? t.linkOut(end.id, end.title, end.label) : t.linkIn(end.id, end.title, end.label);
  return (
    <Tooltip content={tip} side="top">
      <button
        type="button"
        data-df-chip
        aria-label={tip}
        className={CHIP}
        style={{ pointerEvents: "auto" }}
        onClick={(e) => {
          e.stopPropagation();
          actions.goToScreen(end.id);
        }}
      >
        {dir === "in" ? <ArrowLeft size={11} className="shrink-0" /> : <ArrowRight size={11} className="shrink-0" />}
        <span data-tone={end.tone} className="shrink-0 font-medium tabular-nums" style={{ color: "var(--tone)" }}>
          {end.id}
        </span>
        {named && <span className="max-w-[160px] min-w-0 truncate">{end.title}</span>}
      </button>
    </Tooltip>
  );
}

function LinkList({ dir, ends }: { dir: "in" | "out"; ends: LinkEnd[] }) {
  const actions = useContext(CanvasActions);
  const label = dir === "out" ? t.linksOut(ends.length) : t.linksIn(ends.length);
  return (
    <Menu>
      <MenuTrigger
        render={<button type="button" data-df-chip aria-label={label} title={label} className={CHIP} style={{ pointerEvents: "auto" }} onClick={(e) => e.stopPropagation()} />}
      >
        {dir === "in" ? <ArrowLeft size={11} className="shrink-0" /> : <ArrowRight size={11} className="shrink-0" />}
        <span className="tabular-nums">{ends.length}</span>
      </MenuTrigger>
      <MenuPopup side="top" align="end" className="max-h-[min(420px,70vh)] overflow-y-auto">
        {ends.map((e) => (
          <MenuItem key={e.id} onClick={() => actions.goToScreen(e.id)}>
            <span data-tone={e.tone} className="w-11 shrink-0 font-mono text-[12px] tabular-nums" style={{ color: "var(--tone)" }}>
              {e.id}
            </span>
            <span className="min-w-0 truncate">{e.title}</span>
            {e.label && <span className="ml-auto max-w-[180px] shrink-0 truncate pl-3 text-[12px] text-muted-foreground">{e.label}</span>}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** A screen as a live page in its own sandboxed frame, scaled into its box, which the canvas talks to by message. */
function LiveFrame({ flow, screen, width, commenting }: { flow: Flow; screen: Screen; width: number; commenting: boolean }) {
  const vp = viewportOf(flow, screen);
  const channel = useMemo(() => `${screen.id}:${Math.random().toString(36).slice(2)}`, [screen.id]);
  const doc = useMemo(() => screenDocument(flow, screen, { channel }), [flow.style, flow.viewport, screen.html, screen.htmlLine === undefined, screen.viewport, channel]);
  const frame = useRef<HTMLIFrameElement>(null);
  // Hidden until its page is in, so the picture under it shows meanwhile.
  const [ready, setReady] = useState(false);

  // Before paint, so the first load is not missed: tell a frame that loads (again) what the canvas has asked of it.
  useLayoutEffect(() => {
    const el = frame.current;
    const entry: FrameEntry = { screen: screen.id, window: () => el?.contentWindow, element: () => el, loaded: false };
    frames.set(channel, entry);
    const again = () => {
      entry.loaded = true;
      const win = el?.contentWindow;
      if (!win) return;
      if (paused.has(screen.id)) win.postMessage({ channel, type: "motion", on: false }, "*");
      const items = asked.get(screen.id);
      if (items) win.postMessage({ channel, type: "locate", items }, "*");
      if (ringed?.screen === screen.id) win.postMessage({ channel, type: "highlight", selector: ringed.selector }, "*");
      const flash = flashes.get(screen.id);
      flashes.delete(screen.id);
      if (flash && Date.now() - flash.at < FLASH_WAIT_MS) win.postMessage({ channel, type: "flash", selector: flash.selector }, "*");
    };
    el?.addEventListener("load", again);
    return () => {
      el?.removeEventListener("load", again);
      frames.delete(channel);
    };
  }, [channel, screen.id]);

  useEffect(() => {
    const post = () => frame.current?.contentWindow?.postMessage({ channel, type: "commenting", on: commenting }, "*");
    post();
    const el = frame.current;
    el?.addEventListener("load", post);
    return () => el?.removeEventListener("load", post);
  }, [commenting, channel, doc]);

  return (
    <iframe
      ref={frame}
      title={`${screen.id} ${screen.title}`}
      sandbox="allow-scripts"
      data-channel={channel}
      srcDoc={doc}
      onLoad={() => setReady(true)}
      className="nodrag nopan absolute top-0 left-0 origin-top-left border-0"
      style={{
        width: vp.width,
        height: vp.height,
        transform: `scale(${width / vp.width})`,
        pointerEvents: commenting ? "auto" : "none",
        opacity: ready ? 1 : 0,
      }}
    />
  );
}

/** Collapses every other lane and shows this one. */
function OnlyLane({ lane }: { lane: Lane }) {
  const actions = useContext(CanvasActions);
  return (
    <Tooltip content={t.onlyLane} side="top">
      <button
        type="button"
        data-lane-toggle
        aria-label={t.onlyLaneNamed(lane.title)}
        className="nodrag nopan grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:text-foreground"
        style={{ pointerEvents: "auto" }}
        onClick={() => actions.onlyLane(lane.id)}
      >
        <Focus size={14} />
      </button>
    </Tooltip>
  );
}

export function LaneNodeView({ data }: NodeProps<LaneNode>) {
  const { lane, width, height, fit, collapsed } = data;
  const actions = useContext(CanvasActions);
  const box = {
    borderColor: "color-mix(in oklab, var(--tone) 30%, transparent)",
    background: "color-mix(in oklab, var(--tone) 6%, var(--canvas))",
  };
  if (collapsed)
    return (
      // Collapsed: one row with the title and what the lane holds; lines into and out of the lane end on it.
      <div data-tone={lane.tone} data-anchor="lane" data-lane={lane.id} data-collapsed className="relative" style={{ width, height }}>
        <Handle id="in-left" type="target" position={Position.Left} />
        <Handle id="in-right" type="target" position={Position.Right} />
        <Handle id="out-right" type="source" position={Position.Right} />
        <Handle id="out-left" type="source" position={Position.Left} />
        <div
          data-df-lane-row
          className="absolute inset-x-0 top-3 flex h-10 items-center gap-2 rounded-2xl border-[1.5px] border-dashed px-3 text-[18px] font-medium whitespace-nowrap"
          style={{ ...box, color: "var(--tone)", "--fit": String(fit) } as CSSProperties}
        >
          <button
            type="button"
            data-lane-toggle
            aria-expanded={false}
            aria-label={t.expandLane(lane.title)}
            className="nodrag nopan flex cursor-pointer items-center gap-2"
            style={{ pointerEvents: "auto" }}
            onClick={() => actions.toggleLane(lane.id)}
          >
            <ChevronRight size={16} className="shrink-0" />
            {lane.title}
            <span className="text-[13px] font-normal text-muted-foreground">{t.laneScreens(collapsed.screens)}</span>
          </button>
          {collapsed.comments > 0 && (
            <span aria-label={t.laneComments(collapsed.comments)} className="flex items-center gap-1 text-[13px] font-normal text-muted-foreground tabular-nums">
              <MessageSquare size={13} />
              {collapsed.comments}
            </span>
          )}
          <span className="ml-auto" />
          <OnlyLane lane={lane} />
        </div>
      </div>
    );
  return (
    <div
      data-tone={lane.tone}
      data-anchor="lane"
      data-lane={lane.id}
      className="relative rounded-3xl border-[1.5px] border-dashed"
      style={{ width, height, ...box }}
    >
      <div
        data-df-lane-title
        className="absolute bottom-[calc(100%-6px)] left-6 flex items-center gap-1.5 overflow-hidden px-2.5 text-[18px] font-medium whitespace-nowrap"
        style={{ color: "var(--tone)", background: "var(--canvas)", "--fit": String(fit) } as CSSProperties}
      >
        <button
          type="button"
          data-lane-toggle
          aria-expanded
          aria-label={t.collapseLane(lane.title)}
          className="nodrag nopan flex cursor-pointer items-center gap-1.5"
          style={{ pointerEvents: "auto" }}
          onClick={() => actions.toggleLane(lane.id)}
        >
          <ChevronDown size={16} className="shrink-0" />
          {lane.title}
        </button>
        {lane.enter === "any" && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{t.enterAny}</span>}
        <OnlyLane lane={lane} />
      </div>
      {lane.note && <div className="absolute bottom-3 left-6 text-[13px] text-muted-foreground">{lane.note}</div>}
    </div>
  );
}
