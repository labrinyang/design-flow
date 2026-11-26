import { IconButton, Panel, Tooltip } from "@astrafoundry/design/ui";
import { useViewportStore } from "@xyflow/react";
import { ArrowRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Focus, MessageSquare, PanelLeftClose } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { Badge, Flow } from "../../src/core/flow.ts";
import { t } from "./i18n.ts";
import type { Board } from "./lanes.ts";
import { legendOf } from "./model.ts";

/**
 * The lanes, listed beside the canvas: a click on a name goes to that lane, the chevron collapses or opens it, and
 * the button at the end shows only that lane. The lane across the middle of the view is marked. Below the list,
 * what the lines and badges mean.
 */
export function LanesPanel({
  flow,
  board,
  comments,
  bottom,
  onGo,
  onToggle,
  onOnly,
  onCollapseAll,
  onExpandAll,
  onClose,
}: {
  flow: Flow;
  board: Board;
  /** Open comments per lane. */
  comments?: ReadonlyMap<string, number>;
  /** Room to leave free at the bottom of the canvas (the minimap's). */
  bottom: number;
  onGo: (lane: string) => void;
  onToggle: (lane: string) => void;
  onOnly: (lane: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onClose: () => void;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of flow.screens) if (s.lane) m.set(s.lane, (m.get(s.lane) ?? 0) + 1);
    return m;
  }, [flow]);
  const badges = useMemo(() => legendOf(flow).flatMap((it) => (it.kind === "badge" ? [it.badge] : [])), [flow]);
  // The canvas's height, read on resize, so the marked lane follows panning without measuring on every frame.
  const height = useRef(800);
  useEffect(() => {
    const update = () => {
      height.current = document.querySelector(".react-flow")?.getBoundingClientRect().height ?? height.current;
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const current = useViewportStore((s) => {
    const [, ty, zoom] = s.transform;
    const y = (height.current / 2 - ty) / zoom;
    return board.layout.lanes.find((l) => y >= l.y - 28 && y < l.y + l.height + 28)?.id;
  });
  // The marked lane stays in sight in the list, unless the pointer is in the list (someone is reading or scrolling it).
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = list.current;
    const row = ul?.querySelector<HTMLElement>("[data-current]");
    if (!ul || !row || ul.matches(":hover")) return;
    const r = row.getBoundingClientRect();
    const box = ul.getBoundingClientRect();
    if (r.top < box.top) ul.scrollTop -= box.top - r.top + 4;
    else if (r.bottom > box.bottom) ul.scrollTop += r.bottom - box.bottom + 4;
  }, [current]);
  return (
    <Panel
      data-lanes-panel
      className="nodrag nopan nowheel absolute top-4 left-4 z-10 flex w-[260px] flex-col rounded-[18px] p-1.5"
      style={{ maxHeight: `calc(100% - ${16 + bottom}px)` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5 py-0.5 pl-2.5">
        <h2 className="text-[13px] font-medium">{t.lanes}</h2>
        <span className="ml-1.5 text-[12px] text-muted-foreground tabular-nums">{flow.lanes.length}</span>
        <span className="ml-auto" />
        <Tooltip content={t.collapseAll} side="bottom">
          <IconButton label={t.collapseAll} size="sm" variant="ghost" disabled={board.collapsed.size === flow.lanes.length} onClick={onCollapseAll}>
            <ChevronsDownUp size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t.expandAll} side="bottom">
          <IconButton label={t.expandAll} size="sm" variant="ghost" disabled={board.collapsed.size === 0} onClick={onExpandAll}>
            <ChevronsUpDown size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t.hideLanes} side="bottom">
          <IconButton label={t.hideLanes} size="sm" variant="ghost" onClick={onClose}>
            <PanelLeftClose size={15} />
          </IconButton>
        </Tooltip>
      </div>
      <ul ref={list} className="min-h-0 flex-1 overflow-y-auto">
        {flow.lanes.map((lane) => {
          const shut = board.collapsed.has(lane.id);
          const open = comments?.get(lane.id) ?? 0;
          return (
            <li
              key={lane.id}
              data-tone={lane.tone}
              data-current={current === lane.id || undefined}
              className="group flex items-center rounded-[10px] pr-1 hover:bg-muted data-current:bg-muted/70"
            >
              <button
                type="button"
                aria-expanded={!shut}
                aria-label={shut ? t.expandLane(lane.title) : t.collapseLane(lane.title)}
                className="grid size-7 shrink-0 cursor-pointer place-items-center text-muted-foreground hover:text-foreground"
                onClick={() => onToggle(lane.id)}
              >
                {shut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                type="button"
                aria-label={t.goToLane(lane.title)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-left text-[13px]"
                onClick={() => onGo(lane.id)}
              >
                <i className="size-2 shrink-0 rounded-full" style={{ background: "var(--tone)" }} />
                <span className={"min-w-0 truncate" + (shut ? " text-muted-foreground" : "")}>{lane.title}</span>
              </button>
              {open > 0 && (
                <span aria-label={t.laneComments(open)} className="flex shrink-0 items-center gap-0.5 px-1 text-[12px] text-muted-foreground tabular-nums">
                  <MessageSquare size={12} />
                  {open}
                </span>
              )}
              <span aria-label={t.laneScreens(counts.get(lane.id) ?? 0)} className="w-6 shrink-0 text-right text-[12px] text-muted-foreground tabular-nums group-hover:hidden">
                {counts.get(lane.id) ?? 0}
              </span>
              <Tooltip content={t.onlyLane} side="right">
                <button
                  type="button"
                  aria-label={t.onlyLaneNamed(lane.title)}
                  className="hidden size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground group-hover:grid hover:text-foreground"
                  onClick={() => onOnly(lane.id)}
                >
                  <Focus size={14} />
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <Key badges={badges} />
    </Panel>
  );
}

/** What the lines, link chips and badges on the canvas mean. */
function Key({ badges }: { badges: Badge[] }) {
  return (
    <div aria-label={t.legend} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-2.5 pt-2 pb-1 text-[12px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Stroke />
        {t.keyNext}
      </span>
      <span className="flex items-center gap-1.5">
        <Stroke dashed />
        {t.keyBack}
      </span>
      <span className="flex items-center gap-1.5">
        <Stroke color="var(--danger)" />
        {t.keyError}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="grid h-[16px] w-[22px] place-items-center rounded-full bg-card ring-1 ring-border">
          <ArrowRight size={10} />
        </span>
        {t.keyLink}
      </span>
      {badges.map((b) => (
        <span key={b} className="rounded-full bg-substrate px-2 py-0.5 text-[11px] text-substrate-hi">
          {t.badge[b]}
        </span>
      ))}
    </div>
  );
}

function Stroke({ dashed, color = "var(--muted-foreground)" }: { dashed?: boolean; color?: string }) {
  return (
    <svg width="20" height="8" aria-hidden className="shrink-0">
      <path d="M1 4 H19" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
    </svg>
  );
}
