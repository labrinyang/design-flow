import { IconButton } from "@astrafoundry/design/ui";
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { playDocument } from "../../src/core/play.ts";
import type { Flow } from "../../src/core/flow.ts";
import { t } from "./i18n.ts";

/** The whole flow as a working demo: one screen at a time, fitted to the window at its own viewport size. */
export function Play({ flow, prototype, start, onClose }: { flow: Flow; prototype?: string; start: string; onClose: () => void }) {
  const vp = flow.viewport ?? { width: 390, height: 844 };
  const channel = useMemo(() => `play:${Math.random().toString(36).slice(2)}`, []);
  const [run, setRun] = useState(0);
  const doc = useMemo(() => playDocument(flow, prototype, { start, channel }), [flow, prototype, start, channel, run]);
  const frame = useRef<HTMLIFrameElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [current, setCurrent] = useState(start);
  const [canBack, setCanBack] = useState(false);

  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const fit = () => setScale(Math.min((el.clientWidth - 64) / vp.width, (el.clientHeight - 64) / vp.height));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [vp.width, vp.height]);

  const post = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...m, channel }, "*");
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.channel !== channel) return;
      if (e.data.type === "escape") return onClose();
      if (e.data.type !== "screen") return;
      setCurrent(e.data.id);
      setCanBack(!!e.data.canBack);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("message", onMsg);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("keydown", onKey);
    };
  }, [channel, onClose]);

  const screen = flow.screens.find((s) => s.id === current);
  return (
    <div data-play className="fixed inset-0 z-50 flex flex-col bg-[var(--canvas)]" role="dialog" aria-label={t.play}>
      <div className="flex items-center gap-2 px-4 py-3">
        <IconButton label={t.back} size="sm" variant="ghost" disabled={!canBack} onClick={() => post({ type: "back" })}>
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton label={t.restart} size="sm" variant="ghost" onClick={() => setRun((n) => n + 1)}>
          <RotateCcw size={15} />
        </IconButton>
        <p className="min-w-0 flex-1 truncate text-center text-[14px]">
          <span className="mr-2 font-mono text-[12px] text-muted-foreground tabular-nums">{current}</span>
          {screen?.title}
        </p>
        <IconButton label={t.close} size="sm" variant="ghost" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div ref={room} className="relative flex-1 overflow-hidden">
        <div
          className="absolute top-1/2 left-1/2 overflow-hidden rounded-[28px] bg-white shadow-3 ring-1 ring-border"
          style={{ width: vp.width, height: vp.height, transform: `translate(-50%, -50%) scale(${scale})` }}
        >
          <iframe key={run} ref={frame} title={t.play} sandbox="allow-scripts" srcDoc={doc} className="block border-0" style={{ width: vp.width, height: vp.height }} />
        </div>
      </div>
    </div>
  );
}
