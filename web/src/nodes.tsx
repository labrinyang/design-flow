import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { t } from "./i18n.ts";
import { LABEL_H, NOTE_H, type LaneNode, type ScreenNode } from "./model.ts";
import type { FrameElement } from "./anchor.ts";
import { acceptFrameLocated, acceptFrameMessage, acceptFrameWheel, frameToClient, screenDocument, viewportOf, type FrameWheelData, type Located } from "./screen-doc.ts";

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

/** Reports from every frame go through one listener on the canvas: "comment" (a commenting click) and "located". */
export const frameEvents = new EventTarget();
const frames = new Map<string, { screen: string; window: () => Window | null | undefined; element: () => HTMLIFrameElement | null }>();

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
 * What the canvas has asked of each screen's frame, kept so a frame that loads again (after an edit) is
 * told again: whether its motion is paused, and which commented elements to report on.
 */
const paused = new Set<string>();
const asked = new Map<string, { id: string; selector: string }[]>();
let ringed: { screen: string; selector: string } | undefined;

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

/** Ring one element in a screen's frame for a moment. */
export function flashInFrame(screen: string, selector: string) {
  postTo(screen, { type: "flash", selector });
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

export function ScreenNodeView({ data }: NodeProps<ScreenNode>) {
  const { screen, tone, flow, commenting } = data;
  const vp = viewportOf(flow, screen);
  const w = data.width;
  const h = data.height;
  const scale = w / vp.width;
  const channel = useMemo(() => `${screen.id}:${Math.random().toString(36).slice(2)}`, [screen.id]);
  const doc = useMemo(() => screenDocument(flow, screen, { channel }), [flow.style, flow.viewport, screen.html, screen.htmlLine === undefined, screen.viewport, channel]);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    frames.set(channel, { screen: screen.id, window: () => frame.current?.contentWindow, element: () => frame.current });
    return () => void frames.delete(channel);
  }, [channel, screen.id]);

  useEffect(() => {
    const post = () => frame.current?.contentWindow?.postMessage({ channel, type: "commenting", on: commenting }, "*");
    post();
    const el = frame.current;
    el?.addEventListener("load", post);
    return () => el?.removeEventListener("load", post);
  }, [commenting, channel, doc]);

  // A frame that loads again starts over: tell it again whether to pause, what to report on, and what to ring.
  useEffect(() => {
    const el = frame.current;
    const again = () => {
      const win = el?.contentWindow;
      if (!win) return;
      if (paused.has(screen.id)) win.postMessage({ channel, type: "motion", on: false }, "*");
      const items = asked.get(screen.id);
      if (items) win.postMessage({ channel, type: "locate", items }, "*");
      if (ringed?.screen === screen.id) win.postMessage({ channel, type: "highlight", selector: ringed.selector }, "*");
    };
    el?.addEventListener("load", again);
    return () => el?.removeEventListener("load", again);
  }, [channel, screen.id]);

  return (
    <div data-tone={tone} className="relative" style={{ width: w, height: h }}>
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <Handle id="out-right" type="source" position={Position.Right} />
      <Handle id="out-left" type="source" position={Position.Left} />
      <div
        data-anchor="screen"
        data-screen={screen.id}
        data-df-label
        className="absolute bottom-full left-0 flex flex-col justify-end pb-1.5 text-[14px] leading-tight"
        style={{ height: LABEL_H, "--w": `${w}px` } as CSSProperties}
      >
        <span data-id className="shrink-0 text-[12px] font-medium tracking-wide tabular-nums" style={{ color: "var(--tone)" }}>
          {screen.id}
        </span>
        <span data-title className="min-w-0 truncate text-foreground">
          {screen.title}
        </span>
      </div>
      <div
        data-anchor="screen"
        data-screen={screen.id}
        data-frame
        className="relative h-full overflow-hidden rounded-xl shadow-2 ring-1 ring-border"
        style={{ background: "white" }}
      >
        <iframe
          ref={frame}
          title={`${screen.id} ${screen.title}`}
          sandbox="allow-scripts"
          data-channel={channel}
          srcDoc={doc}
          className="nodrag nopan origin-top-left border-0"
          style={{
            width: vp.width,
            height: vp.height,
            transform: `scale(${scale})`,
            pointerEvents: commenting ? "auto" : "none",
          }}
        />
        {screen.badges.length > 0 && (
          <div className="pointer-events-none absolute right-2 bottom-2 flex gap-1">
            {screen.badges.map((b) => (
              <span key={b} className="rounded-full bg-substrate px-2 py-0.5 text-[10px] text-substrate-hi">
                {t.badge[b]}
              </span>
            ))}
          </div>
        )}
      </div>
      {screen.note && (
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

export function LaneNodeView({ data }: NodeProps<LaneNode>) {
  const { lane, width, height } = data;
  return (
    <div
      data-tone={lane.tone}
      data-anchor="lane"
      data-lane={lane.id}
      className="relative rounded-3xl border-[1.5px] border-dashed"
      style={{
        width,
        height,
        borderColor: "color-mix(in oklab, var(--tone) 30%, transparent)",
        background: "color-mix(in oklab, var(--tone) 6%, var(--canvas))",
      }}
    >
      <div
        data-df-lane-title
        className="absolute -top-3.5 left-6 flex items-baseline gap-3 overflow-hidden px-2.5 text-[18px] font-medium whitespace-nowrap"
        style={{ color: "var(--tone)", background: "var(--canvas)", "--w": `${width}px` } as CSSProperties}
      >
        {lane.title}
        {lane.enter === "any" && <span className="text-[12px] font-normal text-muted-foreground">{t.enterAny}</span>}
      </div>
      {lane.note && <div className="absolute bottom-3 left-6 text-[13px] text-muted-foreground">{lane.note}</div>}
    </div>
  );
}
