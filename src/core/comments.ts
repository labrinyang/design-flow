import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Flow } from "./flow.ts";

export type Locale = "en" | "zh";
export interface Point {
  x: number;
  y: number;
}
export type Anchor =
  /** An element inside a screen's HTML: a CSS selector from the screen's body, plus what it showed. */
  | { type: "element"; screen: string; selector: string; tag: string; text: string; point: Point }
  | { type: "screen"; screen: string; point: Point }
  | { type: "edge"; edge: { from: string; to: string; index?: number }; point: Point }
  | { type: "lane"; lane: string; point: Point }
  | { type: "canvas"; point: Point; near?: string };

export type Author = "user" | "agent";
export interface Message {
  id: string;
  author: Author;
  text: string;
  at: string;
  delivered?: boolean;
}
export interface Thread {
  id: string;
  anchor: Anchor;
  status: "open" | "resolved";
  createdAt: string;
  messages: Message[];
}
export interface Delivery {
  threadId: string;
  messageId: string;
  first: boolean;
  text: string;
  anchor: Anchor;
}

/** The edge at `index` when it still joins the same screens, else the first edge between them. */
function findEdge(flow: Flow, ref: { from: string; to: string; index?: number }) {
  const at = ref.index !== undefined ? flow.edges[ref.index] : undefined;
  if (at && at.from === ref.from && at.to === ref.to) return at;
  return flow.edges.find((x) => x.from === ref.from && x.to === ref.to);
}

export function isOrphan(a: Anchor, flow: Flow): boolean {
  switch (a.type) {
    case "element":
      return !flow.screens.some((s) => s.id === a.screen);
    case "screen":
      return !flow.screens.some((s) => s.id === a.screen);
    case "edge":
      return !findEdge(flow, a.edge);
    case "lane":
      return !flow.lanes.some((l) => l.id === a.lane);
    case "canvas":
      return false;
  }
}

export function describeAnchor(a: Anchor, flow: Flow, locale: Locale): string {
  const zh = locale === "zh";
  const q = (t: string) => (zh ? `“${t}”` : `"${t}"`);
  const removed = zh ? "（已删除）" : " (removed)";
  const screenName = (id: string) => {
    const s = flow.screens.find((x) => x.id === id);
    return s ? `${zh ? "帧" : "Screen"} ${s.id} ${s.title}` : `${zh ? "帧" : "Screen"} ${id}${removed}`;
  };
  switch (a.type) {
    case "screen":
      return screenName(a.screen);
    case "element": {
      const text = a.text ? ` ${zh ? q(a.text).trim() : q(a.text)}` : "";
      const sel = zh ? `（${a.selector}）` : ` (${a.selector})`;
      return `${screenName(a.screen)} · ${a.tag}${zh ? text.trim() : text}${sel}`;
    }
    case "edge": {
      const e = findEdge(flow, a.edge);
      const base = `${zh ? "连线" : "Edge"} ${a.edge.from} → ${a.edge.to}`;
      if (!e) return base + removed;
      return e.label ? `${base} ${q(e.label)}` : base;
    }
    case "lane": {
      const l = flow.lanes.find((x) => x.id === a.lane);
      return `${zh ? "泳道" : "Lane "}${q(l ? l.title : a.lane)}${l ? "" : removed}`;
    }
    case "canvas":
      return a.near ? (zh ? `画布空白处，靠近 ${a.near}` : `Canvas, near ${a.near}`) : zh ? "画布空白处" : "Canvas";
  }
}

/** Run fn while holding an exclusive lockfile next to `file`; stale locks (>5 s) are broken. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
      } catch {
        /* lock vanished */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

const readThreads = (file: string): Thread[] => {
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, "utf8")).threads as Thread[]) ?? [];
  } catch {
    return [];
  }
};

export class CommentStore {
  private constructor(
    private readonly file: string,
    public threads: Thread[],
  ) {}

  static load(dir: string): CommentStore {
    const file = join(dir, "comments.json");
    return new CommentStore(file, readThreads(file));
  }

  /** Re-read under the lock, apply the change to the fresh copy, save. */
  private mutate<T>(fn: (threads: Thread[]) => T): T {
    return withLock(this.file, () => {
      const threads = readThreads(this.file);
      const out = fn(threads);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, threads }, null, 2) + "\n");
      renameSync(tmp, this.file);
      this.threads = threads;
      return out;
    });
  }

  private static find(threads: Thread[], id: string): Thread {
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error(`no comment thread ${id}`);
    return t;
  }

  addThread(anchor: Anchor, text: string): Thread {
    const at = new Date().toISOString();
    const t: Thread = {
      id: randomUUID().slice(0, 8),
      anchor,
      status: "open",
      createdAt: at,
      messages: [{ id: randomUUID().slice(0, 8), author: "user", text, at }],
    };
    this.mutate((ts) => ts.push(t));
    return t;
  }

  reply(threadId: string, author: Author, text: string): Message {
    const m: Message = { id: randomUUID().slice(0, 8), author, text, at: new Date().toISOString() };
    if (author === "agent") m.delivered = true;
    this.mutate((ts) => {
      const t = CommentStore.find(ts, threadId);
      t.messages.push(m);
      if (author === "user" && t.status === "resolved") t.status = "open";
    });
    return m;
  }

  resolve(threadId: string) {
    this.mutate((ts) => (CommentStore.find(ts, threadId).status = "resolved"));
  }

  reopen(threadId: string) {
    this.mutate((ts) => (CommentStore.find(ts, threadId).status = "open"));
  }

  /** User messages the agent has not seen yet; marks them delivered. */
  takeUndelivered(): Delivery[] {
    if (!existsSync(this.file)) return [];
    return this.mutate((ts) => {
      const out: Delivery[] = [];
      for (const t of ts)
        t.messages.forEach((m, i) => {
          if (m.author !== "user" || m.delivered) return;
          m.delivered = true;
          out.push({ threadId: t.id, messageId: m.id, first: i === 0, text: m.text, anchor: t.anchor });
        });
      return out;
    });
  }
}
