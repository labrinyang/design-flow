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
  | {
      type: "element";
      screen: string;
      selector: string;
      tag: string;
      text: string;
      point: Point;
      /** The element's box when the comment was made, in the screen's page CSS px: its client rect plus the scroll. */
      box?: { x: number; y: number; width: number; height: number };
      /** Where in that box the comment points, each 0 to 1. */
      offset?: Point;
      /** Up to 120 characters of the text around the element. */
      near?: string;
      /** The prototype.html line its tag starts on. */
      line?: number;
    }
  | { type: "screen"; screen: string; point: Point }
  | { type: "edge"; edge: { from: string; to: string; index?: number }; point: Point }
  | { type: "lane"; lane: string; point: Point }
  | { type: "canvas"; point: Point; near?: string };
export type ElementAnchor = Extract<Anchor, { type: "element" }>;

export type Author = "user" | "agent";
export interface Message {
  id: string;
  author: Author;
  text: string;
  at: string;
  /** An agent message can offer choices; the user picks one with a click. */
  options?: string[];
  /** Index of the option the agent recommends. */
  recommended?: number;
  /** Index of the option the agent has already applied to the design. */
  applied?: number;
  /** A user message made by picking: the agent message and the index of the option picked. */
  pick?: { message: string; option: number };
}
export interface Thread {
  id: string;
  anchor: Anchor;
  status: "open" | "resolved";
  createdAt: string;
  messages: Message[];
  /**
   * How many messages, from the first, the agent has read. A message counts as read once its text was
   * printed to the agent, by a command it ran or by the prompt hook; sending it to a watcher does not
   * count, since a watcher's output may reach no one. Messages are only ever appended, so one count says it.
   */
  seen?: number;
}
/** What an agent offers with a reply: two to four options, and the one it recommends or has applied. */
export interface Offer {
  options: string[];
  recommended?: number;
  applied?: number;
}
/** A user message the agent has not read. */
export interface Unread {
  threadId: string;
  messageId: string;
  first: boolean;
  /** The message as the agent should read it: a pick names the option. */
  text: string;
  anchor: Anchor;
}

export const optionLetter = (i: number) => String.fromCharCode(65 + i);

/**
 * How many messages of `t` the agent has read. Files from before read tracking have no count: there a
 * resolved thread counts as read, and an open one as read up to the agent's last reply. Their `delivered`
 * flags are ignored, because a watcher that no agent was reading set them too.
 */
export function seenCount(t: Thread): number {
  if (typeof t.seen === "number") return Math.min(Math.max(0, t.seen), t.messages.length);
  if (t.status === "resolved") return t.messages.length;
  for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].author === "agent") return i + 1;
  return 0;
}

/** What message `m` of `t` says, for the agent: a pick names the option it chose. */
export function messageText(t: Thread, m: Message): string {
  if (!m.pick) return m.text;
  const offer = t.messages.find((x) => x.id === m.pick!.message);
  return `picked ${optionLetter(m.pick.option)}: ${offer?.options?.[m.pick.option] ?? m.text}`;
}

/** The user messages of an open thread the agent has not read. A resolved thread has none: it is settled. */
export function unreadIn(t: Thread): Unread[] {
  if (t.status !== "open") return [];
  const from = seenCount(t);
  const out: Unread[] = [];
  t.messages.forEach((m, i) => {
    if (i >= from && m.author === "user") out.push({ threadId: t.id, messageId: m.id, first: i === 0, text: messageText(t, m), anchor: t.anchor });
  });
  return out;
}

function checkOffer(o: Offer) {
  const n = o.options.length;
  if (n < 2 || n > 4) throw new RangeError("offer two to four options");
  if (o.options.some((x) => typeof x !== "string" || !x.trim() || x.length > 300)) throw new RangeError("each option needs a label of up to 300 characters");
  for (const k of ["recommended", "applied"] as const) {
    const v = o[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v >= n)) throw new RangeError(`${k} must be the index of one of the options`);
  }
  if (o.recommended === undefined && o.applied === undefined) throw new RangeError("say which option you recommend, or which one you applied");
}

/** A new message; an agent's can carry an offer. */
function newMessage(author: Author, text: string, offer?: Offer): Message {
  const m: Message = { id: randomUUID().slice(0, 8), author, text, at: new Date().toISOString() };
  if (offer) {
    if (author !== "agent") throw new RangeError("only the agent offers options");
    checkOffer(offer);
    m.options = offer.options.map((x) => x.trim());
    if (offer.recommended !== undefined) m.recommended = offer.recommended;
    if (offer.applied !== undefined) m.applied = offer.applied;
  }
  return m;
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

  /** The user messages the agent has not read, in open threads. Reading this marks nothing. */
  unread(): Unread[] {
    return this.threads.flatMap(unreadIn);
  }

  /** Re-read under the lock, apply the change to the fresh copy, save. */
  private mutate<T>(fn: (threads: Thread[]) => T): T {
    return withLock(this.file, () => {
      const threads = readThreads(this.file);
      const out = fn(threads);
      // Left by versions that counted a push to a watcher as delivered; read state is `seen` now.
      for (const t of threads) for (const m of t.messages) delete (m as { delivered?: boolean }).delivered;
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
      seen: 0,
    };
    this.mutate((ts) => ts.push(t));
    return t;
  }

  /**
   * A thread the agent starts, to ask the user something on the canvas. Its first message is the agent's own, so it
   * counts as read; the user's answer, typed or picked, is unread as usual.
   */
  ask(anchor: Anchor, text: string, offer?: Offer): Thread {
    const m = newMessage("agent", text, offer);
    const t: Thread = { id: randomUUID().slice(0, 8), anchor, status: "open", createdAt: m.at, messages: [m], seen: 1 };
    this.mutate((ts) => ts.push(t));
    return t;
  }

  /** Append a message; an agent's can carry an offer. A user's reopens a resolved thread. */
  reply(threadId: string, author: Author, text: string, offer?: Offer): Message {
    const m = newMessage(author, text, offer);
    this.mutate((ts) => {
      const t = CommentStore.find(ts, threadId);
      t.messages.push(m);
      if (author === "user" && t.status === "resolved") t.status = "open";
    });
    return m;
  }

  /** The user picks option `option` of agent message `messageId`: a user message, which reopens a resolved thread. */
  pick(threadId: string, messageId: string, option: number): Message {
    return this.mutate((ts) => {
      const t = CommentStore.find(ts, threadId);
      const offer = t.messages.find((x) => x.id === messageId);
      if (!offer?.options?.length) throw new RangeError(`message ${messageId} in thread ${threadId} offers no options`);
      if (!Number.isInteger(option) || option < 0 || option >= offer.options.length) throw new RangeError(`no option ${option} in message ${messageId}`);
      const m: Message = { id: randomUUID().slice(0, 8), author: "user", text: offer.options[option], at: new Date().toISOString(), pick: { message: messageId, option } };
      t.messages.push(m);
      if (t.status === "resolved") t.status = "open";
      return m;
    });
  }

  resolve(threadId: string) {
    this.mutate((ts) => (CommentStore.find(ts, threadId).status = "resolved"));
  }

  /**
   * Resolve for the agent, only if it has read the whole thread: otherwise leave it open and return the
   * messages it has not read, so the user's last word is never closed unseen.
   */
  resolveIfRead(threadId: string): Unread[] {
    return this.mutate((ts) => {
      const t = CommentStore.find(ts, threadId);
      const missed = unreadIn(t);
      if (!missed.length) t.status = "resolved";
      return missed;
    });
  }

  reopen(threadId: string) {
    this.mutate((ts) => (CommentStore.find(ts, threadId).status = "open"));
  }

  /**
   * Record that these threads were printed to the agent as this store last loaded them: their messages up to
   * then count as read. A message added since stays unread. Call it after printing, never before.
   */
  markRead(threadIds: Iterable<string>) {
    const shown = new Map<string, number>();
    for (const id of threadIds) {
      const t = this.threads.find((x) => x.id === id);
      if (t) shown.set(id, t.messages.length);
    }
    if (!shown.size) return;
    this.mutate((ts) => {
      for (const t of ts) {
        const n = shown.get(t.id);
        if (n !== undefined) t.seen = Math.max(seenCount(t), Math.min(n, t.messages.length));
      }
    });
  }
}
