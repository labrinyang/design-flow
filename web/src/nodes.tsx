import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { t } from "./i18n.ts";
import { LABEL_H, NOTE_H, type LaneNode, type ScreenNode } from "./model.ts";
import { acceptFrameMessage, screenDocument, viewportOf } from "./screen-doc.ts";

export interface FrameClick {
  screen: string;
  /** Viewport (CSS px inside the frame) of the click. */
  x: number;
  y: number;
  element: { selector: string; tag: string; text: string } | null;
}

/** Click reports from every frame go through one listener on the canvas. */
export const frameEvents = new EventTarget();
const frames = new Map<string, { screen: string; window: () => Window | null | undefined }>();

if (typeof window !== "undefined")
  window.addEventListener("message", (e) => {
    const click = acceptFrameMessage(e, frames);
    if (click) frameEvents.dispatchEvent(new CustomEvent<FrameClick>("comment", { detail: click }));
  });

/** Ring one element inside a screen's frame (or clear every frame's ring with no screen). */
export function highlightInFrame(screen: string | undefined, selector: string | undefined) {
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
  const doc = useMemo(() => screenDocument(flow, screen, { channel }), [flow.style, flow.viewport, screen.html, screen.viewport, channel]);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    frames.set(channel, { screen: screen.id, window: () => frame.current?.contentWindow });
    return () => void frames.delete(channel);
  }, [channel, screen.id]);

  useEffect(() => {
    const post = () => frame.current?.contentWindow?.postMessage({ channel, type: "commenting", on: commenting }, "*");
    post();
    const el = frame.current;
    el?.addEventListener("load", post);
    return () => el?.removeEventListener("load", post);
  }, [commenting, channel, doc]);

  return (
    <div data-tone={tone} className="relative" style={{ width: w, height: h }}>
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <Handle id="out-right" type="source" position={Position.Right} />
      <Handle id="out-left" type="source" position={Position.Left} />
      <div
        data-anchor="screen"
        data-screen={screen.id}
        className="absolute inset-x-0 flex flex-col justify-end pb-1.5 text-[14px] leading-tight"
        style={{ top: -LABEL_H, height: LABEL_H }}
      >
        <span className="text-[12px] font-medium tracking-wide tabular-nums" style={{ color: "var(--tone)" }}>
          {screen.id}
        </span>
        <span className="truncate text-foreground">{screen.title}</span>
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
        className="absolute -top-3.5 left-6 flex items-baseline gap-3 px-2.5 text-[18px] font-medium"
        style={{ color: "var(--tone)", background: "var(--canvas)" }}
      >
        {lane.title}
        {lane.enter === "any" && <span className="text-[12px] font-normal text-muted-foreground">{t.enterAny}</span>}
      </div>
      {lane.note && <div className="absolute bottom-3 left-6 text-[13px] text-muted-foreground">{lane.note}</div>}
    </div>
  );
}
