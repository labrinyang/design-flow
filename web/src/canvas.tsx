import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  DialogFooter,
  IconButton,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Toggle,
} from "@astrafoundry/design/ui";
import {
  Background,
  BackgroundVariant,
  getNodesBounds,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  ViewportPortal,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { ArrowLeft, Download, LayoutGrid, Maximize, MessageSquare, MessageSquarePlus, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Point } from "../../src/core/comments.ts";
import { describeAnchor } from "../../src/core/comments.ts";
import type { Flow } from "../../src/core/flow.ts";
import type { Layout } from "../../src/core/layout.ts";
import { anchorFromFrame, anchorFromTarget, exportBounds } from "./anchor.ts";
import { snapshotImageStyle, snapshotSvg, viewportOf } from "./screen-doc.ts";
import { api, useFeature, type FeatureState } from "./api.ts";
import { CommentPanel, NewComment } from "./comments.tsx";
import { FlowEdgeView } from "./edges.tsx";
import { locale, t } from "./i18n.ts";
import { legendOf, toReactFlow } from "./model.ts";
import { frameEvents, LaneNodeView, ScreenNodeView, type FrameClick } from "./nodes.tsx";

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
const STATUS_TONE = { draft: "neutral", approved: "success", stale: "danger" } as const;

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

function buildNodes(flow: Flow, layout: Layout): Node[] {
  const g = toReactFlow(flow, layout);
  const nodes: Node[] = g.nodes as Node[];
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
            "nodrag nopan absolute flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[12px] font-medium tabular-nums shadow-3 transition-transform " +
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
  const [draft, setDraft] = useState<{ anchor: Anchor; screen: { x: number; y: number } }>();
  const [withComments, setWithComments] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string>();
  useEffect(() => setApproveError(undefined), [approving, state?.sha256]);
  const fitted = useRef(false);

  const graph = useMemo(() => (state?.flow && state.layout ? toReactFlow(state.flow, state.layout) : undefined), [state]);
  useEffect(() => {
    if (state?.flow && state.layout) setNodes(buildNodes(state.flow, state.layout));
  }, [state, setNodes]);
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
      const anchor = anchorFromFrame(click, box, viewportOf(state.flow, screen).width);
      const at = rf.flowToScreenPosition(anchor.point);
      const host = document.querySelector("main")!.getBoundingClientRect();
      setDraft({ anchor, screen: { x: at.x - host.left, y: at.y - host.top } });
    };
    frameEvents.addEventListener("comment", onFrame);
    return () => frameEvents.removeEventListener("comment", onFrame);
  }, [state, rf]);
  useEffect(() => {
    if (nodes.length && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => rf.fitView({ padding: 0.06 }));
    }
  }, [nodes, rf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, []);


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
      if (target.closest("[data-pin], [data-draft], [data-comment-panel], .react-flow__panel")) return;
      const point: Point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const anchor = anchorFromTarget(target, { x: Math.round(point.x), y: Math.round(point.y) }, state.layout.screens);
      const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setDraft({ anchor, screen: { x: e.clientX - host.left, y: e.clientY - host.top } });
      e.stopPropagation();
    },
    [commenting, state, rf],
  );

  const exportPng = useCallback(async () => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) return;
    const nodeBoxes = getNodesBounds(rf.getNodes());
    const pins = withComments && state ? state.threads.filter((x) => x.status === "open").map((x) => ({ x: x.anchor.point.x - 14, y: x.anchor.point.y - 28, width: 28, height: 28 })) : [];
    const b = exportBounds([nodeBoxes, ...pins], 48);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas");
    // Sandboxed frames cannot be read from outside: ask each for its markup and put a picture in its place.
    const restore = await swapFramesForSnapshots(viewport);
    const url = await toPng(viewport, {
      backgroundColor: bg.trim() || undefined,
      width: b.width,
      height: b.height,
      pixelRatio: 2,
      filter: (n) => withComments || !(n instanceof HTMLElement && n.dataset.pin !== undefined),
      style: { width: `${b.width}px`, height: `${b.height}px`, transform: `translate(${-b.x}px, ${-b.y}px) scale(1)` },
    });
    restore();
    const a = document.createElement("a");
    a.href = url;
    a.download = `${feature}.png`;
    a.click();
  }, [rf, feature, withComments, state]);

  if (error) return <div className="p-10 text-muted-foreground">{error}</div>;
  if (!state) return null;
  const { flow, layout, status, issues } = state;
  const openCount = state.threads.filter((x) => x.status === "open").length;

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
        <Badge tone={STATUS_TONE[status.status]} className="shrink-0">
          {status.status === "draft" ? t.waiting : t.status[status.status]}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {flow && <Legend flow={flow} />}
          <span className="mx-1 h-5 w-px bg-border" />
          <IconButton label={t.zoomOut} size="sm" onClick={() => rf.zoomOut()}>
            <Minus size={16} />
          </IconButton>
          <IconButton label={t.zoomIn} size="sm" onClick={() => rf.zoomIn()}>
            <Plus size={16} />
          </IconButton>
          <IconButton label={t.fit} size="sm" onClick={() => rf.fitView({ padding: 0.06, duration: 200 })}>
            <Maximize size={15} />
          </IconButton>
          <IconButton label={t.relayout} size="sm" onClick={() => void api.clearLayout(project, feature).then(setState)}>
            <LayoutGrid size={15} />
          </IconButton>
          <Popover>
            <PopoverTrigger render={<IconButton label={t.exportPng} size="sm" />}>
              <Download size={15} />
            </PopoverTrigger>
            <PopoverPopup className="w-60 space-y-3">
              <label className="flex items-center gap-2 text-[14px]">
                <Checkbox checked={withComments} onCheckedChange={(v) => setWithComments(v === true)} />
                {t.exportWithComments}
              </label>
              <Button size="sm" variant="secondary" className="w-full" onClick={() => void exportPng()}>
                {t.exportPng}
              </Button>
            </PopoverPopup>
          </Popover>
          <span className="mx-1 h-5 w-px bg-border" />
          <Toggle
            aria-label={t.comment}
            pressed={commenting}
            onPressedChange={setCommenting}
            size="sm"
            title={`${t.comment} (C)`}
          >
            <MessageSquarePlus size={15} />
          </Toggle>
          <Button size="sm" variant="secondary" onClick={() => setPanelOpen((v) => !v)}>
            <MessageSquare size={15} />
            <span className="tabular-nums">{openCount}</span>
          </Button>
          <Button size="sm" variant="primary" disabled={!flow || issues.length > 0 || status.status === "approved"} onClick={() => setApproving(true)}>
            {t.approve}
          </Button>
          <AlertDialog open={approving} onOpenChange={setApproving}>
            <AlertDialogPopup>
              <AlertDialogTitle>{t.approveTitle}</AlertDialogTitle>
              <AlertDialogDescription>{t.approveBody(openCount)}</AlertDialogDescription>
              {approveError && (
                <p role="alert" className="text-[14px]" style={{ color: "var(--danger)" }}>
                  {t.approveChanged}
                </p>
              )}
              <DialogFooter>
                <AlertDialogClose render={<Button variant="secondary" />}>{t.cancel}</AlertDialogClose>
                <Button variant="primary" onClick={() => void api.approve(project, feature, state.sha256).then(
                      (st) => {
                        setState(st);
                        setApproving(false);
                      },
                      (e: Error) => {
                        setApproveError(e.message);
                      },
                    )}>
                  {t.approve}
                </Button>
              </DialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      </header>
      {!connected && <div className="bg-accent px-4 py-1.5 text-[13px] text-accent-foreground">{t.disconnected}</div>}
      {commenting && <div className="bg-accent px-4 py-1.5 text-[13px] text-accent-foreground">{t.commentHint}</div>}
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
            edges={graph.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={!commenting}
            minZoom={0.1}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            zoomOnScroll={false}
            panOnScroll
            zoomActivationKeyCode="Meta"
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
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
          <div data-draft className="absolute z-20" style={{ left: Math.min(draft.screen.x, innerWidth - 300), top: draft.screen.y }}>
            <NewComment
              where={describeAnchor(draft.anchor, flow, locale)}
              onCancel={() => setDraft(undefined)}
              onSubmit={(text) =>
                void api.comment(project, feature, draft.anchor, text).then((s) => {
                  setState(s);
                  setDraft(undefined);
                  setPanelOpen(true);
                })
              }
            />
          </div>
        )}
        {panelOpen && (
          <CommentPanel
            state={state}
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
