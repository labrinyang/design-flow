import { Button, IconButton } from "@astrafoundry/design/ui";
import {
  Background,
  BackgroundVariant,
  getNodesBounds,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useOptionsStore,
  useReactFlow,
  useViewport,
  useViewportStore,
  ViewportPortal,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { ArrowLeft, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Point } from "../../src/core/comments.ts";
import { describeAnchor } from "../../src/core/comments.ts";
import type { Flow } from "../../src/core/flow.ts";
import type { Layout } from "../../src/core/layout.ts";
import { anchorFromFrame, anchorFromTarget, exportBounds } from "./anchor.ts";
import { snapshotImageStyle, snapshotSvg, viewportOf } from "./screen-doc.ts";
import { api, useFeature, type FeatureState } from "./api.ts";
import { CommentPanel, NewComment } from "./comments.tsx";
import { markOf, placeDraft } from "./draft.ts";
import { FlowEdgeView } from "./edges.tsx";
import { locale, t } from "./i18n.ts";
import { LABEL_H, LANE_TITLE_OVERHANG, legendOf, NOTE_H, toReactFlow } from "./model.ts";
import { frameEvents, highlightInFrame, LaneNodeView, ScreenNodeView, type FrameClick } from "./nodes.tsx";
import { Toolbar } from "./toolbar.tsx";
import { Play as PlayView } from "./play.tsx";
import { ShareMenu } from "./share.tsx";
import { actualSizeZoom, chromeScale, fitViewport, IS_MAC, MAX_ZOOM, MIN_ZOOM, pinScale, wheelZoomStep, zoomAround, type Insets } from "./zoom.ts";

function NotesNode({ data }: { data: { notes: string[] } }) {
  return (
    <div className="w-[65ch] text-[14px] leading-relaxed text-foreground">
      <h3 className="mb-1 text-[16px] font-medium">{t.notes}</h3>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {data.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

const nodeTypes: NodeTypes = { screen: ScreenNodeView, lane: LaneNodeView, notes: NotesNode };
const edgeTypes: EdgeTypes = { flow: FlowEdgeView };

export function Legend({ flow }: { flow: Flow }) {
  const items = legendOf(flow);
  if (!items.length) return null;
  return (
    <div aria-label={t.legend} className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground xl:flex">
      {items.map((it, i) =>
        it.kind === "lane" ? (
          <span key={i} data-tone={it.tone} className="flex items-center gap-1.5">
            <i className="inline-block size-3 rounded-sm" style={{ background: "var(--tone)" }} />
            {it.label}
          </span>
        ) : (
          <span key={i} className="rounded-full bg-substrate px-2 py-0.5 text-[11px] text-substrate-hi">
            {t.badge[it.badge]}
          </span>
        ),
      )}
    </div>
  );
}

/** Text width in canvas pixels, in the page's own font. */
const measureText = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return (text: string, f: { size: number; weight: number }) => {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * f.size * 0.56;
    ctx.font = `${f.weight} ${f.size}px ${getComputedStyle(document.body).fontFamily}`;
    return ctx.measureText(text).width;
  };
})();

function buildNodes(g: { nodes: Node[] }, flow: Flow, layout: Layout): Node[] {
  const nodes: Node[] = [...g.nodes];
  if (flow.notes.length)
    nodes.push({ id: "notes", type: "notes", position: { x: 40, y: layout.height }, data: { notes: flow.notes }, draggable: false, selectable: false });
  return nodes;
}

function Pins({ state, active, onPick }: { state: FeatureState; active?: string; onPick: (id: string) => void }) {
  const open = state.threads.filter((x) => x.status === "open");
  return (
    <ViewportPortal>
      {open.map((th, i) => (
        <button
          key={th.id}
          type="button"
          data-pin
          aria-label={th.where}
          onClick={(e) => {
            e.stopPropagation();
            onPick(th.id);
          }}
          className={
            "nodrag nopan absolute flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[12px] font-medium tabular-nums shadow-3 transition-[scale] " +
            (active === th.id ? "scale-110 bg-primary text-primary-foreground" : "bg-substrate text-substrate-hi")
          }
          style={{ left: th.anchor.point.x, top: th.anchor.point.y, pointerEvents: "all" }}
        >
          {i + 1}
        </button>
      ))}
    </ViewportPortal>
  );
}

function CanvasInner({ project, feature }: { project: string; feature: string }) {
  const { state, setState, connected, error } = useFeature(project, feature);
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [commenting, setCommenting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeThread, setActiveThread] = useState<string>();
  const [draft, setDraft] = useState<{ anchor: Anchor }>();
  const [playing, setPlaying] = useState(false);
  const fitted = useRef(false);

  // Labels and lane titles are measured in the page's font, so lines are routed again once it has loaded.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    const family = getComputedStyle(document.body).fontFamily;
    // load() starts the page font's regular and medium faces and settles once they are in; fonts.ready alone can settle before they are even requested.
    void Promise.all([document.fonts.load(`400 13px ${family}`), document.fonts.load(`500 13px ${family}`)])
      .catch(() => undefined)
      .then(() => setFontsReady(true));
  }, []);
  const graph = useMemo(
    () => (state?.flow && state.layout ? toReactFlow(state.flow, state.layout, { measure: measureText, enterAny: t.enterAny }) : undefined),
    // fontsReady is not read inside: it only triggers measuring again.
    [state, fontsReady],
  );
  useEffect(() => {
    if (graph && state?.flow && state.layout) setNodes(buildNodes(graph as { nodes: Node[] }, state.flow, state.layout));
  }, [graph, state, setNodes]);
  // Frames forward clicks only while commenting.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.type === "screen" ? { ...n, data: { ...n.data, commenting } } : n)));
  }, [commenting, state, setNodes]);
  // A commenting click inside a frame becomes an element (or screen) comment.
  useEffect(() => {
    const onFrame = (e: Event) => {
      const click = (e as CustomEvent<FrameClick>).detail;
      if (!state?.flow || !state.layout) return;
      const screen = state.flow.screens.find((x) => x.id === click.screen);
      const box = state.layout.screens[click.screen];
      if (!screen || !box) return;
      setDraft({ anchor: anchorFromFrame(click, box, viewportOf(state.flow, screen).width) });
    };
    frameEvents.addEventListener("comment", onFrame);
    return () => frameEvents.removeEventListener("comment", onFrame);
  }, [state, rf]);
  /** Show every screen with its title and note, clear of the toolbar and an open comment panel. */
  const fitToWindow = useCallback(
    (duration = 0) => {
      const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
      const ns = rf.getNodes();
      if (!canvas || !ns.length) return;
      void rf.setViewport(fitViewport(visualBounds(ns), canvas, fitInsets(canvas)), { duration });
    },
    [rf],
  );
  // The first fit waits until every node is measured, so the notes and lane sizes count.
  const nodesReady = useNodesInitialized();
  useEffect(() => {
    if (nodesReady && nodes.length && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => fitToWindow());
    }
  }, [nodesReady, nodes.length, fitToWindow]);

  /** Screens at their real CSS size, around the middle of the canvas. */
  const actualSize = useCallback(() => {
    const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (!canvas || !state?.flow || !state.layout) return;
    const center = rf.screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 });
    void rf.zoomTo(actualSizeZoom(state.flow, state.layout, center), { duration: 200 });
  }, [rf, state]);

  // Ctrl or ⌘ with the wheel, and a trackpad pinch, zoom the canvas wherever the pointer is (a screen,
  // the toolbar, the comment panel, the header), never the browser page. Frames forward theirs here too.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const target = e.target instanceof Element ? e.target : null;
      // The new-comment box keeps its own wheel; Play shows no canvas.
      if (target?.closest("[data-draft], [data-play]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      const r = document.querySelector(".react-flow")?.getBoundingClientRect();
      if (!r) return;
      const p = { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
      void rf.setViewport(zoomAround(rf.getViewport(), p, wheelZoomStep(e.deltaY, e.deltaMode, IS_MAC)));
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘ + / ⌘ − / ⌘ 0 (Ctrl elsewhere) zoom the canvas instead of the page, even while typing a comment.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !playing) {
        const zoom = e.key === "=" || e.key === "+" ? "in" : e.key === "-" || e.key === "_" ? "out" : e.key === "0" ? "fit" : undefined;
        if (zoom) {
          e.preventDefault();
          if (zoom === "in") void rf.zoomIn({ duration: 150 });
          else if (zoom === "out") void rf.zoomOut({ duration: 150 });
          else fitToWindow(200);
          return;
        }
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) setCommenting((v) => !v);
      if (e.key === "Escape") {
        setCommenting(false);
        setDraft(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, fitToWindow, playing]);


  const onNodeDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      const moved = Object.fromEntries(
        dragged.filter((n) => n.type === "screen").map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]),
      );
      if (Object.keys(moved).length) void api.saveLayout(project, feature, moved).then(setState);
    },
    [project, feature, setState],
  );

  const onCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (!commenting || !state?.layout || !state.flow) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-pin], [data-draft], [data-comment-panel], [data-toolbar], .react-flow__panel")) return;
      const point: Point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const anchor = anchorFromTarget(target, { x: Math.round(point.x), y: Math.round(point.y) }, state.layout.screens);
      setDraft({ anchor });
      e.stopPropagation();
    },
    [commenting, state, rf],
  );

  // What the comment being written points at: ring it on the canvas until the draft closes.
  const mark = useMemo(() => (draft && state?.flow ? markOf(draft.anchor, state.flow) : {}), [draft, state?.flow]);
  useEffect(() => {
    highlightInFrame(mark.selector ? mark.screen : undefined, mark.selector);
    setNodes((ns) =>
      ns.map((n) => {
        const on = (n.type === "screen" && !mark.selector && n.id === mark.screen) || (n.type === "lane" && n.id === `lane:${mark.lane}`);
        return n.className === (on ? "df-marked" : undefined) ? n : { ...n, className: on ? "df-marked" : undefined };
      }),
    );
  }, [mark, nodes.length, setNodes]);
  const edges = useMemo(
    () => graph?.edges.map((e) => (e.id === mark.edge ? { ...e, data: { ...e.data!, marked: true } } : e)),
    [graph, mark.edge],
  );

  const exportPng = useCallback(async (withComments: boolean) => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) return;
    const nodeBoxes = getNodesBounds(rf.getNodes());
    const pins = withComments && state ? state.threads.filter((x) => x.status === "open").map((x) => ({ x: x.anchor.point.x - 14, y: x.anchor.point.y - 28, width: 28, height: 28 })) : [];
    const b = exportBounds([nodeBoxes, ...pins], 48);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas");
    // The picture is drawn at 100%, so pins and outlines take their 100% size there whatever the zoom on screen.
    const root = viewport.closest<HTMLElement>(".react-flow");
    const scales = (["--df-chrome", "--df-pin"] as const).map((k) => [k, root?.style.getPropertyValue(k) ?? ""] as const);
    for (const [k] of scales) root?.style.setProperty(k, "1");
    // Sandboxed frames cannot be read from outside: ask each for its markup and put a picture in its place.
    const restore = await swapFramesForSnapshots(viewport);
    let url: string;
    try {
      url = await toPng(viewport, {
        backgroundColor: bg.trim() || undefined,
        width: b.width,
        height: b.height,
        pixelRatio: 2,
        filter: (n) => withComments || !(n instanceof HTMLElement && n.dataset.pin !== undefined),
        style: { width: `${b.width}px`, height: `${b.height}px`, transform: `translate(${-b.x}px, ${-b.y}px) scale(1)` },
      });
    } finally {
      restore();
      for (const [k, v] of scales) root?.style.setProperty(k, v);
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = `${feature}.png`;
    a.click();
  }, [rf, feature, state]);

  if (error) return <div className="p-10 text-muted-foreground">{error}</div>;
  if (!state) return null;
  const { flow, layout, issues } = state;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5">
        <IconButton label={t.back} size="sm" onClick={() => (location.href = "/")}>
          <ArrowLeft size={16} />
        </IconButton>
        <div className="min-w-0 shrink">
          <h1 className="truncate font-display text-[22px] leading-tight">{flow?.title ?? feature}</h1>
          {flow?.subtitle && <p className="truncate text-[13px] text-muted-foreground">{flow.subtitle}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {flow && <Legend flow={flow} />}
          {flow && (
            <>
              <span className="mx-1 h-5 w-px bg-border" />
              <Button size="sm" variant="secondary" onClick={() => setPlaying(true)}>
                <Play size={14} fill="currentColor" />
                {t.play}
              </Button>
              <ShareMenu project={project} feature={feature} onExportPng={(pins) => void exportPng(pins)} />
            </>
          )}
        </div>
      </header>
      {playing && flow && <PlayView flow={flow} prototype={state.prototype} start={startScreen(flow)} onClose={() => setPlaying(false)} />}
      {!connected && <div className="bg-accent px-4 py-1.5 text-[13px] text-accent-foreground">{t.disconnected}</div>}
      {issues.length > 0 && (
        <div role="alert" className="border-b border-border bg-card px-4 py-2 text-[13px]">
          <p className="font-medium" style={{ color: "var(--danger)" }}>
            {flow ? t.issuesTitle(issues.length) : t.noValidFlow}
          </p>
          <ul className="mt-1 font-mono text-[12px] text-muted-foreground">
            {issues.slice(0, 5).map((i, k) => (
              <li key={k}>
                {i.line}:{i.col} {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <main className="relative flex-1" data-commenting={commenting} onClickCapture={onCanvasClick}>
        {graph && flow && layout && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={!commenting}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            zoomOnScroll={false}
            panOnScroll
            zoomActivationKeyCode={null}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
            <ChromeScale />
            <Pins
              state={state}
              active={activeThread}
              onPick={(id) => {
                setActiveThread(id);
                setPanelOpen(true);
              }}
            />
          </ReactFlow>
        )}
        {draft && flow && (
          <DraftAt point={draft.anchor.point}>
            <NewComment
              focusKey={draft.anchor}
              where={describeAnchor(draft.anchor, flow, locale)}
              onCancel={() => setDraft(undefined)}
              onSubmit={(text) =>
                api.comment(project, feature, draft.anchor, text).then((s) => {
                  setState(s);
                  setDraft(undefined);
                  setPanelOpen(true);
                })
              }
            />
          </DraftAt>
        )}
        <Toolbar
          state={state}
          commenting={commenting}
          setCommenting={setCommenting}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          onFit={() => fitToWindow(200)}
          onActualSize={actualSize}
          onRelayout={() => void api.clearLayout(project, feature).then(setState)}
          onApprove={() => api.approve(project, feature, state.sha256).then(setState)}
        />
        {panelOpen && (
          <CommentPanel
            state={state}
            onChange={setState}
            active={activeThread}
            onFocus={(id) => {
              setActiveThread(id);
              const th = state.threads.find((x) => x.id === id);
              if (th) rf.setCenter(th.anchor.point.x, th.anchor.point.y, { zoom: Math.max(rf.getZoom(), 0.8), duration: 250 });
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </main>
    </div>
  );
}

/** Publishes the scales for outlines (--df-chrome) and pins (--df-pin) on the canvas, for index.css. */
function ChromeScale() {
  const zoom = useViewportStore((s) => s.transform[2]);
  const root = useOptionsStore((s) => s.domNode);
  useEffect(() => {
    root?.style.setProperty("--df-chrome", String(chromeScale(zoom)));
    root?.style.setProperty("--df-pin", String(pinScale(zoom)));
  }, [root, zoom]);
  return null;
}

/** Every node's box in flow coordinates, with screen titles and notes and lane titles, which sit outside their nodes. */
function visualBounds(nodes: Node[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    const w = n.measured?.width ?? n.width ?? 0;
    const h = n.measured?.height ?? n.height ?? 0;
    const above = n.type === "screen" ? LABEL_H : n.type === "lane" ? LANE_TITLE_OVERHANG : 0;
    const below = n.type === "screen" ? NOTE_H : 0;
    x0 = Math.min(x0, n.position.x);
    y0 = Math.min(y0, n.position.y - above);
    x1 = Math.max(x1, n.position.x + w);
    y1 = Math.max(y1, n.position.y + h + below);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** What the floating toolbar and an open comment panel cover, plus a margin, on each side of the canvas. */
function fitInsets(canvas: DOMRect): Insets {
  const margin = 24;
  const bar = document.querySelector("[data-toolbar]")?.getBoundingClientRect();
  const panel = document.querySelector("[data-comment-panel]")?.getBoundingClientRect();
  return {
    top: margin,
    left: margin,
    bottom: bar ? Math.max(margin, canvas.bottom - bar.top + 16) : margin,
    right: panel ? Math.max(margin, canvas.right - panel.left + 16) : margin,
  };
}

/**
 * The new-comment box, kept beside its point as the canvas pans and zooms, with a marker on the point.
 * Wheel and pinch over the box stay with the box: they neither move the canvas nor zoom the page.
 */
function DraftAt({ point, children }: { point: Point; children: React.ReactNode }) {
  const rf = useReactFlow();
  useViewport(); // re-render on every pan/zoom
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 300, height: 170 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.offsetWidth, height: el.offsetHeight }));
    ro.observe(el);
    // Native listener: React's wheel handler is passive, so it could not stop a pinch from zooming the page.
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("wheel", stop, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", stop);
    };
  }, []);
  const host = document.querySelector("main")?.getBoundingClientRect();
  if (!host) return null;
  const at = rf.flowToScreenPosition(point);
  const marker = { x: at.x - host.left, y: at.y - host.top };
  const bar = document.querySelector("[data-toolbar]")?.getBoundingClientRect();
  const pos = placeDraft(marker, size, { width: host.width, height: host.height }, bar ? host.bottom - bar.top : 0);
  return (
    <>
      <span
        data-draft-marker
        className="pointer-events-none absolute z-20 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-3"
        style={{ left: marker.x, top: marker.y, background: "var(--yellow-500)" }}
      />
      <div ref={box} data-draft className="nowheel absolute z-20" style={{ ...pos, touchAction: "none" }}>
        {children}
      </div>
    </>
  );
}

/** Where Play starts: the first entry screen (no lane) nothing leads into, else the first screen. */
function startScreen(flow: Flow): string {
  const targets = new Set(flow.edges.map((e) => e.to));
  return (flow.screens.find((s) => !s.lane && !targets.has(s.id)) ?? flow.screens.find((s) => !targets.has(s.id)) ?? flow.screens[0]).id;
}

function snapshotFrame(frame: HTMLIFrameElement): Promise<{ html: string; width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(undefined);
    }, 1500);
    function onMsg(e: MessageEvent) {
      if (e.source !== frame.contentWindow || e.data?.type !== "snapshot" || e.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
    const channel = frame.dataset.channel;
    frame.contentWindow?.postMessage({ channel, type: "snapshot", id }, "*");
  });
}

/** Replace every frame iframe with an <img> of its markup (SVG foreignObject); returns an undo. */
async function swapFramesForSnapshots(root: HTMLElement): Promise<() => void> {
  const frames = [...root.querySelectorAll<HTMLIFrameElement>("iframe[data-channel]")];
  const swaps = await Promise.all(
    frames.map(async (frame) => {
      const snap = await snapshotFrame(frame);
      if (!snap) return undefined;
      const svg = snapshotSvg(snap.html, snap.width, snap.height);
      const img = new Image(snap.width, snap.height);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      img.style.cssText = snapshotImageStyle(frame.style.cssText, snap.width, snap.height);
      img.className = frame.className;
      await img.decode().catch(() => undefined);
      frame.replaceWith(img);
      return () => img.replaceWith(frame);
    }),
  );
  return () => swaps.forEach((undo) => undo?.());
}

export function Canvas(props: { project: string; feature: string }) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
