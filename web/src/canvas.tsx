import { Button, Command, CommandItem, CommandList, IconButton, Tooltip } from "@astrafoundry/design/ui";
import {
  Background,
  BackgroundVariant,
  getNodesBounds,
  MiniMap,
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
import { ArrowLeft, PanelLeft, Play, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Point } from "../../src/core/comments.ts";
import type { Flow } from "../../src/core/flow.ts";
import type { Layout } from "../../src/core/layout.ts";
import { anchorFromFrame, anchorFromTarget, anchorTitle, exportBounds, pinOnElement } from "./anchor.ts";
import { snapshotImageStyle, snapshotSvg, viewportOf, type Located } from "./screen-doc.ts";
import { api, useFeature, type FeatureState } from "./api.ts";
import { CommentPanel, NewComment } from "./comments.tsx";
import { markOf, placeDraft } from "./draft.ts";
import { FlowEdgeView } from "./edges.tsx";
import { locale, t } from "./i18n.ts";
import { collapseLanes, commentsByLane, drawnPoint, fullPoint, type Board } from "./lanes.ts";
import { formatLink, parseLink, type Link } from "./link.ts";
import { pickLive } from "./live.ts";
import { LanesPanel } from "./lanes-panel.tsx";
import { focusEdges, inLane, LABEL_H, LANE_TITLE_OVERHANG, NOTE_H, planBoard, toReactFlow, type ScreenData } from "./model.ts";
import { MOTION_MIN_AREA, MOTION_SETTLE_MS, shouldPlay, type FrameBox } from "./motion.ts";
import {
  CanvasActions,
  flashInFrame,
  frameEvents,
  highlightInFrame,
  LaneNodeView,
  locateInFrames,
  ScreenNodeView,
  setFrameMotion,
  type CanvasActionHandlers,
  type FrameClick,
  type FrameLocated,
} from "./nodes.tsx";
import { cachedRoutes, routeLater, routesKey, type Routes } from "./route-cache.ts";
import type { RouteInput } from "./route.ts";
import { firstNew } from "./seen.ts";
import { useUserSeen } from "./use-seen.ts";
import { Toolbar } from "./toolbar.tsx";
import { Play as PlayView } from "./play.tsx";
import { ShareMenu } from "./share.tsx";
import {
  actualSizeZoom,
  chromeScale,
  COMPACT_LABEL_ZOOM,
  EDGE_LABEL_MIN_ZOOM,
  fitViewport,
  focusZoom,
  IS_MAC,
  labelScale,
  laneTitleScale,
  MAX_ZOOM,
  MIN_ZOOM,
  minZoomFor,
  openViewport,
  pinScale,
  wheelZoomStep,
  zoomAround,
  type Insets,
} from "./zoom.ts";


const MOD = IS_MAC ? "⌘" : "Ctrl ";

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

function Pins({
  state,
  points,
  active,
  pulse,
  onPick,
}: {
  state: FeatureState;
  /** Where each open comment's pin is drawn now; those inside a collapsed lane have none (the lane's row counts them). */
  points: Map<string, Point>;
  active?: string;
  /** The pin to pulse once; n changes on every pulse, so the same pin can pulse again. */
  pulse?: { id: string; n: number };
  onPick: (id: string) => void;
}) {
  const open = state.threads.filter((x) => x.status === "open");
  return (
    <ViewportPortal>
      {open.map((th, i) => {
        const at = points.get(th.id);
        if (!at) return null;
        const where = anchorTitle(th.anchor, state.flow, locale);
        return (
        <button
          key={th.id}
          type="button"
          data-pin
          data-active={active === th.id || undefined}
          data-pulse={pulse?.id === th.id ? pulse.n % 2 : undefined}
          aria-label={t.pinLabel(i + 1, where.detail ? `${where.title} ${where.detail}` : where.title)}
          onClick={(e) => {
            e.stopPropagation();
            onPick(th.id);
          }}
          className={
            "nodrag nopan absolute flex size-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[12px] font-medium tabular-nums shadow-3 transition-[scale] " +
            (active === th.id ? "scale-110 bg-foreground text-background" : "bg-substrate text-substrate-hi")
          }
          style={{ left: at.x, top: at.y, pointerEvents: "all" }}
        >
          {i + 1}
        </button>
        );
      })}
    </ViewportPortal>
  );
}

/** Lanes collapsed on each canvas, kept in this browser. */
const LANES_KEY = "design-flow:lanes";

function readLanes(key: string): ReadonlySet<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Lines routed: from this browser's cache at once, else worked out off the main thread, with step lines meanwhile. */
function useRoutes(input: RouteInput | undefined): Routes | undefined {
  const key = useMemo(() => (input ? routesKey(input) : undefined), [input]);
  const cached = useMemo(() => (key ? cachedRoutes(key) : undefined), [key]);
  const [done, setDone] = useState<{ key: string; routes: Routes }>();
  useEffect(() => {
    if (!key || cached || !input) return;
    let current = true;
    void routeLater(key, input).then((routes) => {
      if (current) setDone({ key, routes });
    });
    return () => {
      current = false;
    };
    // The key names the input: a new plan with the same problem needs no new routes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cached]);
  return cached ?? (done && done.key === key ? done.routes : undefined);
}

function CanvasInner({ project, feature }: { project: string; feature: string }) {
  const { state, setState, thumbs, pictures: drawsPictures, connected, error } = useFeature(project, feature);
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [commenting, setCommenting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeThread, setActiveThread] = useState<string>();
  const [draft, setDraft] = useState<{ anchor: Anchor }>();
  /** Play, once its document has come: prototype.html is fetched when Play opens, not sent with every state. */
  const [play, setPlay] = useState<{ prototype?: string }>();
  const playing = play !== undefined;
  const openPlay = useCallback(() => {
    void api.prototype(project, feature).then(
      (r) => setPlay({ prototype: r.prototype ?? undefined }),
      () => setPlay({}),
    );
  }, [project, feature]);
  const fitted = useRef(false);
  /** The link the page opened with, read before a settled view can rewrite the address with its own screen. */
  const [startLink] = useState(() => parseLink(location.hash));
  /** The view writes the address only once the first view has followed the link the page opened with. */
  const linkReady = useRef(false);
  const [located, setLocated] = useState<Map<string, Located>>(() => new Map());
  const [pulse, setPulse] = useState<{ id: string; n: number }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [minimap, setMinimapState] = useState(() => localStorage.getItem(MINIMAP_KEY) !== "off");
  const setMinimap = useCallback((on: boolean) => {
    setMinimapState(on);
    try {
      localStorage.setItem(MINIMAP_KEY, on ? "on" : "off");
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  }, []);
  const { seen, ready: seenReady, markSeen } = useUserSeen(project, feature, state?.threads);
  /** The thread the URL points at, set by going to it; until the panel closes, the screen in view does not replace it. */
  const linkThread = useRef<string>(undefined);
  /** Screens shown as live frames now (live.ts); the others show their picture. */
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());
  /** The screen last pointed at while commenting: a live frame, so a click lands on an element in it. */
  const [hovered, setHovered] = useState<string>();
  /** The screen under the pointer, and the one a click holds: in focus, its lines show and the rest fall back. */
  const [pointed, setPointed] = useState<string>();
  const [held, setHeld] = useState<string>();
  const pointTimer = useRef<number>(undefined);
  /** When the view last moved, and where the pointer is: while the view moves, screens slide under a still pointer. */
  const motion = useRef<{ at: number; timer?: number }>({ at: 0 });
  const pointer = useRef<{ x: number; y: number }>(undefined);
  /** Each time the view moves; once it stops, the lines of the screen under the pointer then, if any. */
  const onViewMove = useCallback(() => {
    const m = motion.current;
    m.at = performance.now();
    window.clearTimeout(pointTimer.current);
    window.clearTimeout(m.timer);
    m.timer = window.setTimeout(() => {
      const p = pointer.current;
      const node = p ? document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>(".react-flow__node-screen") : undefined;
      setPointed(node?.dataset.id);
    }, POINT_SETTLE_MS);
  }, []);
  /** The screen a link chip just took the view to: it rings once. */
  const [arrived, setArrived] = useState<string>();
  const arrivedTimer = useRef<number>(undefined);
  /** The lanes panel, open or closed as the user left it. */
  const [lanesOpen, setLanesOpenState] = useState(() => localStorage.getItem(LANES_PANEL_KEY) !== "off");
  const setLanesOpen = useCallback((on: boolean) => {
    setLanesOpenState(on);
    try {
      localStorage.setItem(LANES_PANEL_KEY, on ? "on" : "off");
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  }, []);
  /** Lanes collapsed to one row, as the user left them on this canvas. */
  const lanesKey = `${LANES_KEY}:${project}/${feature}`;
  const [collapsed, setCollapsedState] = useState(() => readLanes(lanesKey));
  useEffect(() => setCollapsedState(readLanes(lanesKey)), [lanesKey]);
  const setCollapsed = useCallback(
    (next: ReadonlySet<string>) => {
      setCollapsedState(next);
      try {
        localStorage.setItem(lanesKey, JSON.stringify([...next]));
      } catch {
        /* storage blocked: the lanes stay so for this page */
      }
    },
    [lanesKey],
  );

  // Labels and lane titles are measured in the page's font, so lines are routed again once it has loaded.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    const family = getComputedStyle(document.body).fontFamily;
    // load() starts the page font's regular and medium faces and settles once they are in; fonts.ready alone can settle before they are even requested.
    void Promise.all([document.fonts.load(`400 13px ${family}`), document.fonts.load(`500 13px ${family}`)])
      .catch(() => undefined)
      .then(() => setFontsReady(true));
  }, []);
  const flow = state?.flow;
  const layout = state?.layout;
  /** The board as drawn, with collapsed lanes folded to a row, and the routing problem for its lines. */
  const plan = useMemo(
    () => (flow && layout ? planBoard(flow, layout, { measure: measureText, enterAny: t.enterAny, collapsed, laneSummary: t.laneScreens }) : undefined),
    // fontsReady is not read inside: it only triggers measuring again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow, layout, collapsed, fontsReady],
  );
  const board = plan?.board;
  const routes = useRoutes(plan?.input);
  // Links between lanes are routed after the lines, for when a screen is in focus.
  const linkRoutes = useRoutes(routes ? plan?.linksInput : undefined);
  const focus = !commenting && board ? [held, pointed].find((id) => !!id && !board.hidden.has(id)) : undefined;
  /** The screen in focus and the screens its edges join. */
  const near = useMemo(() => {
    if (!focus || !flow) return undefined;
    const s = new Set([focus]);
    for (const e of flow.edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [focus, flow]);
  const laneComments = useMemo(
    () => (flow && layout && state ? commentsByLane(flow, layout, state.threads.filter((x) => x.status === "open").map((x) => x.anchor)) : undefined),
    [flow, layout, state],
  );
  const graph = useMemo(
    () => (plan && flow && layout ? toReactFlow(flow, layout, { plan, routes: routes ?? [], laneComments }) : undefined),
    [plan, flow, layout, routes, laneComments],
  );
  useEffect(() => {
    if (graph && flow && board) setNodes(buildNodes(graph as { nodes: Node[] }, flow, board.layout));
  }, [graph, flow, board, setNodes]);
  // What each screen shows (a live frame, or its picture), and whether its frame forwards clicks (while commenting).
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.type !== "screen") return n;
        const d = n.data as ScreenData;
        const next = { commenting, live: live.has(n.id), thumb: thumbs[n.id] };
        return d.commenting === next.commenting && d.live === next.live && d.thumb === next.thumb ? n : { ...n, data: { ...d, ...next } };
      }),
    );
  }, [commenting, live, thumbs, graph, setNodes]);
  // A commenting click inside a frame becomes an element (or screen) comment.
  useEffect(() => {
    const onFrame = (e: Event) => {
      const click = (e as CustomEvent<FrameClick>).detail;
      if (!state?.flow || !state.layout) return;
      const screen = state.flow.screens.find((x) => x.id === click.screen);
      const box = state.layout.screens[click.screen];
      if (!screen || !box) return;
      setDraft({ anchor: anchorFromFrame(click, box, viewportOf(state.flow, screen).width, screen.htmlLine) });
    };
    frameEvents.addEventListener("comment", onFrame);
    return () => frameEvents.removeEventListener("comment", onFrame);
  }, [state, rf]);
  // Frames report where commented elements are, now and whenever their page changes, so pins can follow them.
  useEffect(() => {
    const items = new Map<string, { id: string; selector: string }[]>();
    for (const th of state?.threads ?? []) {
      if (th.status !== "open" || th.anchor.type !== "element") continue;
      items.set(th.anchor.screen, [...(items.get(th.anchor.screen) ?? []), { id: th.id, selector: th.anchor.selector }]);
    }
    locateInFrames(items);
  }, [state?.threads]);
  useEffect(() => {
    const onLocated = (e: Event) => {
      const { items } = (e as CustomEvent<FrameLocated>).detail;
      setLocated((prev) => {
        const next = new Map(prev);
        for (const it of items) next.set(it.id, it);
        return next;
      });
    };
    frameEvents.addEventListener("located", onLocated);
    return () => frameEvents.removeEventListener("located", onLocated);
  }, []);
  /**
   * Where each open comment's pin is drawn: on its element as its frame last reported it, else at its point, moved
   * up with the lanes collapsed above it. Pins inside a collapsed lane have none.
   */
  const pinPoints = useMemo(() => {
    const out = new Map<string, Point>();
    if (!state || !flow || !layout || !board) return out;
    for (const th of state.threads) {
      const a = th.anchor;
      if (th.status !== "open") continue;
      if (a.type === "edge") {
        // On its line where the line is drawn (at its label), else on the link chips of the screen it leaves.
        const at = flow.edges.findIndex((x, i) => i === a.edge.index && x.from === a.edge.from && x.to === a.edge.to);
        const index = at >= 0 ? at : flow.edges.findIndex((x) => x.from === a.edge.from && x.to === a.edge.to);
        const line = graph?.edges.find((x) => x.data?.index === index);
        if (line?.data?.route?.label) {
          out.set(th.id, line.data.route.label);
          continue;
        }
        const e = flow.edges[index];
        if (e && !inLane(flow, e)) {
          const box = board.layout.screens[e.from];
          if (box) out.set(th.id, { x: box.x + box.w - 12, y: box.y });
          continue;
        }
      }
      const p = drawnPoint(a, layout, board);
      if (!p) continue;
      const at = a.type === "element" ? located.get(th.id) : undefined;
      const box = a.type === "element" ? board.layout.screens[a.screen] : undefined;
      const screen = a.type === "element" ? flow.screens.find((s) => s.id === a.screen) : undefined;
      if (a.type === "element" && at && !("missing" in at) && box && screen)
        out.set(th.id, pinOnElement({ ...a, point: p }, at, box, viewportOf(flow, screen).width));
      // Until its frame is live and says where the element is: where the element was in its page when commented on.
      else if (a.type === "element" && a.box && box && screen) out.set(th.id, pinOnElement({ ...a, point: p }, a.box, box, viewportOf(flow, screen).width));
      else out.set(th.id, p);
    }
    return out;
  }, [state, flow, layout, board, located, graph]);
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
  /** The first view: the whole board, or the top of a tall one at the window's width (zoom.ts). */
  const openToWindow = useCallback(() => {
    const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
    const ns = rf.getNodes();
    if (!canvas || !ns.length) return;
    void rf.setViewport(openViewport(visualBounds(ns), canvas, fitInsets(canvas)));
  }, [rf]);
  // The first view waits until every node is measured, so the notes and lane sizes count.
  const nodesReady = useNodesInitialized();
  useEffect(() => {
    if (nodesReady && nodes.length && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => {
        openToWindow();
        followLink(startLink);
        linkReady.current = true;
      });
    }
    // followLink reads the state as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesReady, nodes.length, openToWindow]);
  /** After every lane collapses or opens at once, the board is fitted to the window again once it is drawn. */
  const refit = useRef(false);
  useEffect(() => {
    if (!refit.current || !nodes.length) return;
    refit.current = false;
    requestAnimationFrame(() => fitToWindow(250));
  }, [nodes, fitToWindow]);
  /** How far out the canvas zooms: a little past the whole board (zoom.ts). */
  const [minZoom, setMinZoom] = useState(MIN_ZOOM);
  const minZoomNow = useRef(minZoom);
  useEffect(() => {
    minZoomNow.current = minZoom;
  }, [minZoom]);
  useEffect(() => {
    const update = () => {
      const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
      if (!canvas || !nodes.length) return;
      setMinZoom(minZoomFor(fitViewport(visualBounds(nodes), canvas, fitInsets(canvas)).zoom));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [nodes]);

  /** Opens these lanes, and gives the board as it will be drawn then, so the view can move on it right away. */
  const expandLanes = useCallback(
    (ids: string[]): Board | undefined => {
      if (!flow || !layout) return undefined;
      const next = new Set(collapsed);
      for (const id of ids) next.delete(id);
      if (next.size !== collapsed.size) setCollapsed(next);
      return collapseLanes(flow, layout, next);
    },
    [flow, layout, collapsed, setCollapsed],
  );

  /** Show one screen whole and readable, in the part of the canvas the panel and toolbar leave free; its lane opens if collapsed. */
  const focusScreen = useCallback(
    (id: string, duration = 250) => {
      const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
      const screen = flow?.screens.find((s) => s.id === id);
      if (!canvas || !screen || !flow || !board) return;
      const shown = screen.lane && board.collapsed.has(screen.lane) ? expandLanes([screen.lane]) : board;
      const box = shown?.layout.screens[id];
      if (!box) return;
      const insets = fitInsets(canvas);
      const free = { width: canvas.width - insets.left - insets.right, height: canvas.height - insets.top - insets.bottom };
      const zoom = focusZoom({ w: box.w, h: box.h + LABEL_H }, free, viewportOf(flow, screen).width / box.w);
      // The frame with its label above it, centred.
      const cx = box.x + box.w / 2;
      const cy = box.y + (box.h - LABEL_H) / 2;
      void rf.setViewport({ x: insets.left + free.width / 2 - cx * zoom, y: insets.top + free.height / 2 - cy * zoom, zoom }, { duration });
    },
    [rf, flow, board, expandLanes],
  );

  const focusScreenNow = useRef(focusScreen);
  useEffect(() => {
    focusScreenNow.current = focusScreen;
  }, [focusScreen]);

  /** Point the URL at a thread or a screen, without adding to the history. */
  const writeLink = useCallback((link: Link) => {
    const hash = formatLink(link);
    if (hash === location.hash || (!hash && !location.hash)) return;
    history.replaceState(history.state, "", hash || location.pathname + location.search);
  }, []);

  /** Go to a thread from the panel or a link: show where it is, ring its element and pulse its pin once. */
  const jumpTo = useCallback(
    (id: string) => {
      const th = state?.threads.find((x) => x.id === id);
      if (!th || !layout || !board) return;
      const a = th.anchor;
      setActiveThread(id);
      linkThread.current = id;
      writeLink({ thread: id });
      if (a.type === "element" || a.type === "screen") focusScreen(a.screen);
      else {
        // In a collapsed lane: open the lane, and go where the comment is drawn then.
        const lane = a.type === "lane" ? a.lane : board.collapsedAt(a.point);
        const shown = lane && board.collapsed.has(lane) ? (expandLanes([lane]) ?? board) : board;
        const p = (shown === board ? pinPoints.get(id) : undefined) ?? drawnPoint(a, layout, shown) ?? a.point;
        void rf.setCenter(p.x, p.y, { zoom: Math.max(rf.getZoom(), 0.8), duration: 250 });
      }
      window.setTimeout(() => {
        if (a.type === "element") flashInFrame(a.screen, a.selector);
        if (th.status === "open") setPulse((p) => ({ id, n: (p?.n ?? 0) + 1 }));
      }, 280);
    },
    [state, layout, board, rf, focusScreen, expandLanes, pinPoints, writeLink],
  );

  /** A link names a thread (an id or its first characters) or a screen. */
  const followLink = useCallback(
    (link: Link) => {
      if (!state?.flow) return;
      if (link.thread) {
        const exact = state.threads.find((x) => x.id === link.thread);
        const starts = state.threads.filter((x) => x.id.startsWith(link.thread!));
        const th = exact ?? (link.thread.length >= 4 && starts.length === 1 ? starts[0] : undefined);
        if (th) {
          setPanelOpen(true);
          // Once the panel is in, so the view leaves room for it.
          window.setTimeout(() => jumpTo(th.id), 60);
          return;
        }
      }
      if (link.screen && state.flow.screens.some((s) => s.id === link.screen)) focusScreen(link.screen, 0);
    },
    [state, jumpTo, focusScreen],
  );
  useEffect(() => {
    const onHash = () => followLink(parseLink(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [followLink]);

  /**
   * Once the view settles with no thread linked: link the screen in the middle of it (of the part the panels leave
   * free, where going to a screen puts it), if one is big enough to read there.
   */
  const onSettle = useCallback(
    (v: { x: number; y: number; zoom: number }, view: DOMRect) => {
      if (!linkReady.current || linkThread.current || !flow || !board) return;
      const insets = fitInsets(view);
      const c = {
        x: (insets.left + (view.width - insets.left - insets.right) / 2 - v.x) / v.zoom,
        y: (insets.top + (view.height - insets.top - insets.bottom) / 2 - v.y) / v.zoom,
      };
      const hit = flow.screens.find((s) => {
        const b = board.layout.screens[s.id];
        return b && c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y - LABEL_H && c.y <= b.y + b.h && b.w * b.h * v.zoom * v.zoom >= MOTION_MIN_AREA;
      });
      writeLink(hit ? { screen: hit.id } : {});
    },
    [flow, board, writeLink],
  );

  /** Screens at their real CSS size, around the middle of the canvas. */
  const actualSize = useCallback(() => {
    const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (!canvas || !flow || !board) return;
    const center = rf.screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 });
    void rf.zoomTo(actualSizeZoom(flow, board.layout, center), { duration: 200 });
  }, [rf, flow, board]);

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
      void rf.setViewport(zoomAround(rf.getViewport(), p, wheelZoomStep(e.deltaY, e.deltaMode, IS_MAC), minZoomNow.current));
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘ + / ⌘ − / ⌘ 0 (Ctrl elsewhere) zoom the canvas instead of the page, even while typing a comment.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !playing && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
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
        setHeld(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, fitToWindow, playing]);


  const collapsedNow = useRef(collapsed);
  const planNow = useRef(plan);
  useEffect(() => {
    collapsedNow.current = collapsed;
    planNow.current = plan;
  }, [collapsed, plan]);
  /** What lane rows and screens ask of the canvas (nodes.tsx). */
  const actions = useMemo<CanvasActionHandlers>(
    () => ({
      toggleLane: (id) => {
        const next = new Set(collapsedNow.current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setCollapsed(next);
      },
      onlyLane: (id) => {
        const p = planNow.current;
        if (!flow || !layout || !p) return;
        const next = new Set(flow.lanes.map((l) => l.id).filter((l) => l !== id));
        setCollapsed(next);
        // Then show that lane whole, on the board as it is drawn with the others collapsed.
        const bounds = laneBounds(flow, collapseLanes(flow, layout, next), id, p.laneX);
        const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
        if (!bounds || !canvas) return;
        void rf.setViewport(fitViewport(bounds, canvas, fitInsets(canvas)), { duration: 250 });
      },
      hoverScreen: setHovered,
      pointScreen: (id) => {
        // While the view moves, screens slide under a still pointer: their lines wait until it stops (onViewMove).
        if (performance.now() - motion.current.at < POINT_SETTLE_MS) return;
        window.clearTimeout(pointTimer.current);
        // A moment's wait, so sweeping the pointer across screens does not flash each one's lines.
        pointTimer.current = window.setTimeout(() => setPointed(id), id ? 60 : 120);
      },
      holdScreen: (id) => setHeld((h) => (h === id ? undefined : id)),
      goToScreen: (id) => {
        linkThread.current = undefined;
        writeLink({ screen: id });
        focusScreenNow.current(id);
        setHeld(undefined);
        setArrived(id);
        window.clearTimeout(arrivedTimer.current);
        arrivedTimer.current = window.setTimeout(() => setArrived(undefined), 1600);
      },
    }),
    [flow, layout, setCollapsed, rf, writeLink],
  );
  /** Show one lane whole, opening it if it is collapsed. */
  const goToLane = useCallback(
    (id: string) => {
      if (!flow || !plan) return;
      const shown = plan.board.collapsed.has(id) ? (expandLanes([id]) ?? plan.board) : plan.board;
      const bounds = laneBounds(flow, shown, id, plan.laneX);
      const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
      if (!bounds || !canvas) return;
      void rf.setViewport(fitViewport(bounds, canvas, fitInsets(canvas), 1), { duration: 250 });
    },
    [flow, plan, expandLanes, rf],
  );
  const collapseAll = useCallback(() => {
    if (!flow) return;
    refit.current = true;
    setCollapsed(new Set(flow.lanes.map((l) => l.id)));
  }, [flow, setCollapsed]);
  const expandAll = useCallback(() => {
    refit.current = true;
    setCollapsed(new Set());
  }, [setCollapsed]);

  const onCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (!commenting || !layout || !board) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-pin], [data-draft], [data-comment-panel], [data-toolbar], [data-lane-toggle], [data-lanes-panel], [data-df-chip], .react-flow__panel")) return;
      const point: Point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Made on the board as drawn; kept with its point on the full board, which collapsing lanes does not move.
      const drawn = anchorFromTarget(target, { x: Math.round(point.x), y: Math.round(point.y) }, board.layout.screens);
      const at = fullPoint(drawn, layout, board);
      setDraft({ anchor: { ...drawn, point: { x: Math.round(at.x), y: Math.round(at.y) } } });
      e.stopPropagation();
    },
    [commenting, layout, board, rf],
  );

  // What the comment being written points at: ring it on the canvas until the draft closes.
  const mark = useMemo(() => (draft && state?.flow ? markOf(draft.anchor, state.flow) : {}), [draft, state?.flow]);
  useEffect(() => {
    highlightInFrame(mark.selector ? mark.screen : undefined, mark.selector);
  }, [mark]);
  // Ring what the comment is on; while a screen is in focus, the screens its edges do not join fall back.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const marked = (n.type === "screen" && !mark.selector && n.id === mark.screen) || (n.type === "lane" && n.id === `lane:${mark.lane}`);
        const faded = !!near && n.type === "screen" && !near.has(n.id);
        const className = [marked && "df-marked", faded && "df-faded", n.id === arrived && "df-arrived"].filter(Boolean).join(" ") || undefined;
        return n.className === className ? n : { ...n, className };
      }),
    );
  }, [mark, near, arrived, nodes.length, graph, setNodes]);
  /** The lines inside lanes; while a screen is in focus, its links to other lanes as well, and the rest fall back. */
  const edges = useMemo(() => {
    if (!graph || !plan || !flow) return undefined;
    const lines = graph.edges.map((e) => {
      const marked = e.id === mark.edge;
      const touches = !!focus && (e.source === focus || e.target === focus);
      const faded = !!focus && !touches;
      if (!marked && !touches && !faded) return e;
      return { ...e, data: { ...e.data!, ...(marked ? { marked } : {}), ...(touches ? { focus: true } : {}), ...(faded ? { faded } : {}) } };
    });
    if (!focus || !linkRoutes) return lines;
    return [...lines, ...focusEdges(flow, plan, linkRoutes, focus).map((e) => ({ ...e, data: { ...e.data!, focus: true } }))];
  }, [graph, plan, flow, mark.edge, focus, linkRoutes]);

  // What decides which screens are live frames (FrameGate).
  const boxes = useMemo(
    () =>
      flow && board
        ? flow.screens.flatMap((s) => {
            const b = board.layout.screens[s.id];
            return b ? [{ id: s.id, x: b.x, y: b.y, w: b.w, h: b.h }] : [];
          })
        : [],
    [flow, board],
  );
  const pictures = useMemo(() => new Set(Object.keys(thumbs)), [thumbs]);
  const draftScreen = draft && (draft.anchor.type === "element" || draft.anchor.type === "screen") ? draft.anchor.screen : undefined;
  const force = useMemo(
    () => new Set([commenting ? hovered : undefined, draftScreen].filter((x): x is string => !!x)),
    [commenting, hovered, draftScreen],
  );
  const draftPoint = draft && layout && board ? (drawnPoint(draft.anchor, layout, board) ?? board.toView(draft.anchor.point)) : undefined;

  const exportPng = useCallback(async (withComments: boolean) => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) return;
    const nodeBoxes = getNodesBounds(rf.getNodes());
    const pins =
      withComments && state
        ? state.threads
            .filter((x) => x.status === "open")
            .map((x) => {
              const p = pinPoints.get(x.id) ?? x.anchor.point;
              return { x: p.x - 14, y: p.y - 28, width: 28, height: 28 };
            })
        : [];
    const b = exportBounds([nodeBoxes, ...pins], 48);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--canvas");
    // The picture is drawn at 100%, so it looks as the canvas does at 100% whatever the zoom on screen: pins,
    // outlines, labels and lane titles at their own size, labels whole with their link chips, and line labels shown.
    const root = viewport.closest<HTMLElement>(".react-flow");
    const scales = (["--df-chrome", "--df-pin", "--df-label", "--df-lane"] as const).map((k) => [k, root?.style.getPropertyValue(k) ?? ""] as const);
    const flags = (["data-compact", "data-no-edge-labels"] as const).map((k) => [k, root?.hasAttribute(k) ?? false] as const);
    for (const [k] of scales) root?.style.setProperty(k, "1");
    for (const [k] of flags) root?.removeAttribute(k);
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
      for (const [k, on] of flags) root?.toggleAttribute(k, on);
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = `${feature}.png`;
    a.click();
  }, [rf, feature, state, pinPoints]);

  if (error) return <div className="p-10 text-muted-foreground">{error}</div>;
  if (!state) return null;
  const { issues } = state;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5">
        <IconButton label={t.back} size="sm" onClick={() => (location.href = "/")}>
          <ArrowLeft size={16} />
        </IconButton>
        {flow && flow.lanes.length > 1 && (
          <Tooltip content={lanesOpen ? t.hideLanes : t.showLanes} side="bottom">
            <IconButton label={lanesOpen ? t.hideLanes : t.showLanes} size="sm" variant="ghost" aria-pressed={lanesOpen} onClick={() => setLanesOpen(!lanesOpen)}>
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
        )}
        <div className="min-w-0 shrink">
          <h1 className="truncate font-display text-[22px] leading-tight">{flow?.title ?? feature}</h1>
          {flow?.subtitle && <p className="truncate text-[13px] text-muted-foreground">{flow.subtitle}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {flow && (
            <Tooltip content={`${t.searchScreens} (${MOD}K)`} side="bottom">
              <IconButton label={t.searchScreens} size="sm" variant="ghost" onClick={() => setSearchOpen(true)}>
                <Search size={16} />
              </IconButton>
            </Tooltip>
          )}
          {flow && (
            <>
              <span className="mx-1 h-5 w-px bg-border" />
              <Button size="sm" variant="secondary" onClick={openPlay}>
                <Play size={14} fill="currentColor" />
                {t.play}
              </Button>
              <ShareMenu project={project} feature={feature} onExportPng={(pins) => void exportPng(pins)} />
            </>
          )}
        </div>
      </header>
      {play && flow && <PlayView flow={flow} prototype={play.prototype} start={startScreen(flow)} onClose={() => setPlay(undefined)} />}
      {flow && (
        <ScreenSearch
          flow={flow}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onPick={(id) => {
            linkThread.current = undefined;
            writeLink({ screen: id });
            focusScreen(id);
          }}
        />
      )}
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
      <main
        className="relative flex-1"
        data-commenting={commenting}
        onClickCapture={onCanvasClick}
        onPointerMove={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerLeave={() => {
          pointer.current = undefined;
        }}
      >
        {graph && flow && layout && (
          <CanvasActions.Provider value={actions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            nodesDraggable={false}
            elementsSelectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            minZoom={minZoom}
            maxZoom={MAX_ZOOM}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            zoomOnScroll={false}
            panOnScroll
            zoomActivationKeyCode={null}
            deleteKeyCode={null}
            onPaneClick={() => setHeld(undefined)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
            <ChromeScale />
            <FrameGate boxes={boxes} pictures={pictures} allLive={!drawsPictures} force={force} paused={playing} onLive={setLive} onSettle={onSettle} />
            <MotionWatch onMove={onViewMove} />
            <Pins
              state={state}
              points={pinPoints}
              active={activeThread}
              pulse={pulse}
              onPick={(id) => {
                setActiveThread(id);
                setPanelOpen(true);
                linkThread.current = id;
                writeLink({ thread: id });
              }}
            />
            {minimap && (
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                ariaLabel={t.minimap}
                nodeColor={miniMapColor}
                nodeStrokeColor="transparent"
                nodeBorderRadius={6}
                bgColor="var(--card)"
                maskColor="color-mix(in oklab, var(--canvas) 55%, transparent)"
                className="overflow-hidden rounded-[14px] shadow-2 ring-1 ring-border"
                onClick={(_, p) => void rf.setCenter(p.x, p.y, { zoom: rf.getZoom(), duration: 200 })}
              />
            )}
          </ReactFlow>
          </CanvasActions.Provider>
        )}
        {flow && board && lanesOpen && flow.lanes.length > 1 && (
          <LanesPanel
            flow={flow}
            board={board}
            comments={laneComments}
            bottom={minimap ? 180 : 16}
            onGo={goToLane}
            onToggle={actions.toggleLane}
            onOnly={actions.onlyLane}
            onCollapseAll={collapseAll}
            onExpandAll={expandAll}
            onClose={() => setLanesOpen(false)}
          />
        )}
        {draft && flow && (
          <DraftAt point={draftPoint ?? draft.anchor.point}>
            <NewComment
              focusKey={draft.anchor}
              title={anchorTitle(draft.anchor, flow, locale)}
              onCancel={() => setDraft(undefined)}
              onSubmit={(text) =>
                api.comment(project, feature, draft.anchor, text).then((s) => {
                  const before = new Set(state.threads.map((x) => x.id));
                  setState(s);
                  setDraft(undefined);
                  setPanelOpen(true);
                  const added = s.threads.find((x) => !before.has(x.id));
                  if (added) setActiveThread(added.id);
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
          newReplies={seenReady ? state.threads.filter((x) => firstNew(x.messages, seen[x.id]) !== undefined).length : 0}
          minimap={minimap}
          setMinimap={setMinimap}
          lanes={{ total: flow?.lanes.length ?? 0, collapsed: board?.collapsed.size ?? 0 }}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
          onApprove={() => api.approve(project, feature, state.sha256).then(setState)}
        />
        {panelOpen && (
          <CommentPanel
            state={state}
            onChange={setState}
            active={activeThread}
            numbers={new Map(state.threads.filter((x) => x.status === "open").map((x, i) => [x.id, i + 1]))}
            seen={seen}
            seenReady={seenReady}
            onSeen={markSeen}
            onHover={setActiveThread}
            onJump={jumpTo}
            onClose={() => {
              setPanelOpen(false);
              if (linkThread.current) {
                linkThread.current = undefined;
                writeLink({});
              }
            }}
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
    root?.style.setProperty("--df-label", String(labelScale(zoom)));
    root?.style.setProperty("--df-lane", String(laneTitleScale(zoom)));
    root?.toggleAttribute("data-compact", zoom < COMPACT_LABEL_ZOOM);
    root?.toggleAttribute("data-no-edge-labels", zoom < EDGE_LABEL_MIN_ZOOM);
  }, [root, zoom]);
  return null;
}

/**
 * Decides, once the view has stood still, which screens are live frames (live.ts) and which of those play their
 * animations (motion.ts); everything pauses while Play is open over the canvas. When only what must be live
 * changes (the screen being commented on, a picture that came in), it decides at once.
 */
function FrameGate({
  boxes,
  pictures,
  allLive,
  force,
  paused,
  onLive,
  onSettle,
}: {
  boxes: (FrameBox & { id: string })[];
  pictures: ReadonlySet<string>;
  /** The server draws no pictures (no Chrome): every screen is a live page. */
  allLive: boolean;
  force: ReadonlySet<string>;
  paused: boolean;
  onLive: (live: ReadonlySet<string>) => void;
  onSettle?: (v: { x: number; y: number; zoom: number }, view: DOMRect) => void;
}) {
  const transform = useViewportStore((s) => s.transform);
  const root = useOptionsStore((s) => s.domNode);
  const live = useRef<ReadonlySet<string>>(new Set());
  const playingNow = useRef(new Map<string, boolean>());
  const seen = useRef<string>(undefined);
  const settling = useRef(false);
  useEffect(() => {
    const at = transform.join(",");
    const moved = at !== seen.current;
    seen.current = at;
    if (moved) settling.current = true;
    const decide = () => {
      const r = root?.getBoundingClientRect();
      if (!r) return;
      const v = { x: transform[0], y: transform[1], zoom: transform[2] };
      const next = allLive
        ? new Set(boxes.map((b) => b.id))
        : pickLive(
            boxes.map((b) => ({ ...b, picture: pictures.has(b.id) })),
            v,
            r,
            live.current,
            force,
          );
      if (next.size !== live.current.size || [...next].some((id) => !live.current.has(id))) {
        live.current = next;
        onLive(next);
      }
      for (const b of boxes) {
        const on = !paused && next.has(b.id) && shouldPlay(b, v, r, playingNow.current.get(b.id) ?? true);
        playingNow.current.set(b.id, on);
        setFrameMotion(b.id, on);
      }
      if (settling.current) {
        settling.current = false;
        onSettle?.(v, r);
      }
    };
    if (!moved) return void decide();
    const timer = window.setTimeout(decide, MOTION_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [transform, root, boxes, pictures, allLive, force, paused, onLive, onSettle]);
  return null;
}

/** Tells the canvas each time the view moves; a child of ReactFlow, so only it renders on every frame of a pan. */
function MotionWatch({ onMove }: { onMove: () => void }) {
  const transform = useViewportStore((s) => s.transform);
  useEffect(() => {
    onMove();
  }, [transform, onMove]);
  return null;
}

/** How long the view must stay still before the screen under the pointer shows its lines. */
const POINT_SETTLE_MS = 150;

const MINIMAP_KEY = "design-flow:minimap";
const LANES_PANEL_KEY = "design-flow:lanes-panel";

/** A lane's box with its title, as drawn on `board`: from the lanes' left edge to past its last screen. */
function laneBounds(flow: Flow, board: Board, id: string, laneX: number) {
  const lane = board.layout.lanes.find((l) => l.id === id);
  if (!lane) return undefined;
  const right = Math.max(
    laneX + 480,
    ...flow.screens.filter((s) => s.lane === id && board.layout.screens[s.id]).map((s) => board.layout.screens[s.id].x + board.layout.screens[s.id].w + 24),
  );
  return { x: laneX, y: lane.y - LANE_TITLE_OVERHANG, width: right - laneX, height: lane.height + LANE_TITLE_OVERHANG };
}

/** Screens in the minimap as grey frames; lanes as faint bands of their tone. */
function miniMapColor(n: Node): string {
  if (n.type === "screen") return "color-mix(in oklab, var(--muted-foreground) 55%, transparent)";
  if (n.type === "lane") {
    const tone = (n.data as { lane?: { tone?: string } }).lane?.tone;
    const c = tone === "success" || tone === "info" || tone === "danger" ? `var(--${tone})` : "var(--muted-foreground)";
    return `color-mix(in oklab, ${c} 12%, transparent)`;
  }
  return "transparent";
}

interface ScreenItem {
  id: string;
  title: string;
  lane?: string;
  /** What the search matches: id, title and lane. */
  value: string;
}

/** ⌘K: find a screen by id, name or lane, and go there. */
function ScreenSearch({ flow, open, onOpenChange, onPick }: { flow: Flow; open: boolean; onOpenChange: (open: boolean) => void; onPick: (id: string) => void }) {
  const items = useMemo<ScreenItem[]>(
    () =>
      flow.screens.map((s) => {
        const lane = flow.lanes.find((l) => l.id === s.lane)?.title;
        return { id: s.id, title: s.title, lane, value: [s.id, s.title, lane].filter(Boolean).join(" ") };
      }),
    [flow],
  );
  return (
    <Command
      open={open}
      onOpenChange={onOpenChange}
      label={t.searchScreens}
      placeholder={t.searchPlaceholder}
      empty={t.noMatch}
      items={items}
      itemToStringValue={(it: ScreenItem) => it.value}
    >
      <CommandList>
        {(it: ScreenItem) => (
          <CommandItem
            key={it.id}
            value={it}
            shortcut={it.lane}
            onClick={() => {
              onOpenChange(false);
              onPick(it.id);
            }}
          >
            <span className="w-10 shrink-0 font-mono text-[12px] text-muted-foreground tabular-nums">{it.id}</span>
            <span className="min-w-0 truncate">{it.title}</span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  );
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

/** What the floating toolbar, the lanes panel and an open comment panel cover, plus a margin, on each side of the canvas. */
function fitInsets(canvas: DOMRect): Insets {
  const margin = 24;
  const bar = document.querySelector("[data-toolbar]")?.getBoundingClientRect();
  const panel = document.querySelector("[data-comment-panel]")?.getBoundingClientRect();
  const lanes = document.querySelector("[data-lanes-panel]")?.getBoundingClientRect();
  return {
    top: margin,
    left: lanes ? Math.max(margin, lanes.right - canvas.left + 16) : margin,
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
        style={{ left: marker.x, top: marker.y, background: "var(--foreground)" }}
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
