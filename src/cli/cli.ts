import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { approvalStatus, markApprovalSeen, unseenApproval } from "../core/approval.ts";
import { CommentStore, describeAnchor, messageText, optionLetter, seenCount, type Anchor, type Locale, type Offer, type Thread } from "../core/comments.ts";
import { parseFlow } from "../core/flow.ts";
import { checkPrototype, readPrototype } from "../core/prototype.ts";
import { BUILD, DEFAULT_PORT, projectKey, VERSION } from "../server/server.ts";
import { PROTOTYPE, TEMPLATE } from "./template.ts";
import { UsageError } from "./usage.ts";
import { canonical, claimWatch, linkedProjects, linkSession, sessionId, shellWord } from "./sessions.ts";

declare const __DESIGN_FLOW_BUNDLE__: boolean | undefined;
const FEATURE_RE = /^[a-z0-9][a-z0-9-]*$/;
export const home = () => process.env.DESIGN_FLOW_HOME ?? join(homedir(), ".design-flow");
const locale = (): Locale =>
  (process.env.DESIGN_FLOW_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale).startsWith("zh") ? "zh" : "en";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  /** Flags that may repeat, in order. */
  lists: Record<string, string[]>;
}
/** Flags that take a value, as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = ["text", "project-dir", "option", "recommend", "applied", "element", "scale", "out", "dir", "lane"];
const LIST_FLAGS = ["option", "lane"];
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, lists: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
    let v: string | boolean = eq < 0 ? true : a.slice(eq + 1);
    if (v === true && VALUE_FLAGS.includes(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) v = argv[++i];
    if (!LIST_FLAGS.includes(k)) out.flags[k] = v;
    else if (typeof v === "string") (out.lists[k] ??= []).push(v);
    else throw new UsageError(`--${k} needs a value`);
  }
  return out;
}

/** An option named by its letter (A) or its number (1), as an index. */
function optionIndex(a: Args, flag: string, count: number): number | undefined {
  const v = a.flags[flag];
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  const i = /^[A-Z]$/.test(s) ? s.charCodeAt(0) - 65 : /^\d+$/.test(s) ? Number(s) - 1 : -1;
  if (!count) throw new UsageError(`--${flag} names one of the options; give them with --option`);
  if (i < 0 || i >= count) throw new UsageError(`--${flag} takes the letter (A to ${optionLetter(count - 1)}) or the number (1 to ${count}) of an option`);
  return i;
}

/** The options a reply or a question offers, by the rules of checkOffer; none when there are no --option flags. */
function offerOf(a: Args): Offer | undefined {
  const options = a.lists.option ?? [];
  if (options.length === 1 || options.length > 4) throw new UsageError("offer two to four options, or none");
  const recommended = optionIndex(a, "recommend", options.length);
  const applied = optionIndex(a, "applied", options.length);
  if (options.length && recommended === undefined && applied === undefined)
    throw new UsageError("with options, say which one you recommend (--recommend) or have applied (--applied)");
  return options.length ? { options, recommended, applied } : undefined;
}

/** Where an anchor is in prototype.html, for the agent to open: " prototype.html:42", or nothing. */
const lineNote = (a: Anchor) => (a.type === "element" && a.line ? ` prototype.html:${a.line}` : "");

/** A value flag as a string, or undefined; given without a value it is a usage error. */
function valueFlag(a: Args, k: string): string | undefined {
  const v = a.flags[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v) throw new UsageError(`--${k} needs a value`);
  return v;
}

/** A thread as the agent reads it: messages marked (new) when unread, each offer's options, and its shot when asked for. */
function printThread(t: Thread, where: string, fresh: Set<string>, shot?: { file?: string; note?: string }) {
  console.log(`#${t.id} [${t.status}] ${where}`);
  if (shot?.file) console.log(`  shot: ${shot.file}${shot.note ? ` (${shot.note})` : ""}`);
  else if (shot?.note) console.log(`  shot: none, ${shot.note}`);
  for (const m of t.messages) {
    console.log(`  ${m.author === "agent" ? "agent" : "user "}${fresh.has(m.id) ? " (new)" : ""}: ${messageText(t, m)}`);
    m.options?.forEach((o, i) => {
      const marks = [i === m.recommended ? "recommended" : "", i === m.applied ? "applied" : ""].filter(Boolean);
      console.log(`    ${optionLetter(i)}. ${o}${marks.length ? ` (${marks.join(", ")})` : ""}`);
    });
  }
}

function projectDir(a: Args) {
  return resolve(typeof a.flags["project-dir"] === "string" ? a.flags["project-dir"] : process.cwd());
}
function feature(a: Args, i = 1) {
  const f = a._[i];
  if (!f || !FEATURE_RE.test(f)) throw new UsageError(`feature name must be lowercase letters, digits and hyphens (got "${f ?? ""}")`);
  return f;
}
const featureDir = (dir: string, f: string) => join(dir, ".design-flow", f);
function requireFeature(dir: string, f: string) {
  const d = featureDir(dir, f);
  if (!existsSync(join(d, "flow.yaml"))) throw new UsageError(`no ${join(".design-flow", f, "flow.yaml")}; run: design-flow open ${f}`);
  return d;
}

interface ServerInfo {
  pid: number;
  port: number;
  version: string;
  build?: string;
}
function readInfo(): ServerInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(home(), "server.json"), "utf8"));
  } catch {
    return undefined;
  }
}
async function health(info?: ServerInfo): Promise<{ build?: string } | undefined> {
  if (!info) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return undefined;
    const h = (await r.json()) as { app?: string; build?: string };
    // The recorded port may belong to another program by now: only a design-flow server counts.
    return h.app === "design-flow" ? h : undefined;
  } catch {
    return undefined;
  }
}
const alive = async (info?: ServerInfo) => !!(await health(info));

async function stopServer(info: ServerInfo) {
  try {
    process.kill(info.pid);
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && (await alive(info)); i++) await new Promise((r) => setTimeout(r, 100));
}

export async function runningServer(): Promise<ServerInfo | undefined> {
  const info = readInfo();
  return (await alive(info)) ? info : undefined;
}

async function ensureServer(): Promise<ServerInfo> {
  const info = readInfo();
  const h = await health(info);
  if (h && h.build === BUILD) return info!;
  // A server from another build (left running across an update) would serve the old canvas: replace it.
  if (h && info) await stopServer(info);
  const self = fileURLToPath(import.meta.url);
  // Bundled: this file is scripts/design-flow.mjs and serves with `__serve`. Dev: dist/src/server/main.js.
  const bundled = typeof __DESIGN_FLOW_BUNDLE__ !== "undefined";
  const args = bundled ? [self, "__serve"] : [join(dirname(self), "..", "server", "main.js")];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DESIGN_FLOW_HOME: home() },
  });
  child.unref();
  const before = readInfo();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = readInfo();
    if (info && info.pid === child.pid && (await alive(info))) return info;
    if (info && info !== before && info.pid !== before?.pid && (await alive(info))) return info;
  }
  throw new Error("the design-flow server did not start; see " + join(home(), "server.log"));
}

async function api(info: ServerInfo, path: string, init?: RequestInit) {
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

/** Registers `dir` with `server`, or with the server ensureServer starts or replaces. */
async function register(dir: string, server?: ServerInfo) {
  const info = server ?? (await ensureServer());
  const { key } = await api(info, "/api/projects", { method: "POST", body: JSON.stringify({ dir }) });
  return { info, key: key as string };
}

function printIssues(issues: ReturnType<typeof parseFlow>["issues"], dir: string) {
  for (const i of issues) {
    const rel = i.file.startsWith(dir) ? i.file.slice(dir.length + 1) : i.file;
    console.log(`${rel}:${i.line}:${i.col} ${i.message}${i.hint ? `\n  → ${i.hint}` : ""}`);
  }
}

function staticIssues(fd: string) {
  const file = join(fd, "flow.yaml");
  const { flow, issues } = parseFlow(readFileSync(file, "utf8"), file);
  const proto = join(fd, "prototype.html");
  if (flow && existsSync(proto)) issues.push(...checkPrototype(readPrototype(readFileSync(proto, "utf8")), flow, proto));
  return { valid: !!flow, issues };
}

function check(dir: string, f: string): number {
  const { issues } = staticIssues(requireFeature(dir, f));
  if (!issues.length) {
    console.log(`${f}: clean`);
    return 0;
  }
  printIssues(issues, dir);
  return 3;
}

/** check, then render every screen and add what looks broken; a flow too broken to draw is not rendered. */
async function checkVisual(dir: string, f: string): Promise<number> {
  const fd = requireFeature(dir, f);
  const { valid, issues } = staticIssues(fd);
  if (valid) {
    const { loadFeature, visualCheck } = await import("./visual.ts");
    const feature = loadFeature(fd, f);
    try {
      issues.push(...(await visualCheck(feature)));
    } catch (e) {
      // Without a browser, check's own issues still count.
      printIssues(issues, dir);
      throw e;
    }
    if (!issues.length) {
      console.log(`${f}: clean, ${feature.flow.screens.length} screen${feature.flow.screens.length === 1 ? "" : "s"} rendered`);
      return 0;
    }
  }
  printIssues(issues, dir);
  return 3;
}

const HELP = `design-flow ${VERSION} — UX flow canvas for coding agents

Usage: design-flow <command> [feature] [options]

  open <feature> [--no-open]       Start the server, create flow.yaml if missing, open the canvas
  check <feature> [--visual]       Validate flow.yaml (exit 0 clean, 3 issues); --visual also renders
                                   every screen and reports overflow, cut-off and overlapping text
  shot <feature> <screen>... [--lane <lane>]... [--sheet] [--element <selector>] [--scale 1|2] [--out <file>] [--dir <dir>]
  shot <feature> --all [--sheet] [--dir <dir>]
                                   Render screens to PNG (in the temp dir by default) and print each path;
                                   --sheet puts them on labelled overview images and prints those
  outline <feature> [<screen>] [--json]
                                   Screens, edges and threads; with a screen, its rendered element tree
  comments <feature> [--unread] [--json] [--shots]
                                   Show comment threads; what it shows counts as read. --shots adds a shot
                                   of each commented screen, its element ringed, and a sheet of them all
  reply <feature> <thread> --text <text> [--option <text>]... [--recommend <A>] [--applied <A>]
                                   Reply as the agent; with 2 to 4 options the user picks one with a click
  ask <feature> <screen> --text <text> [--element <selector>] [--option <text>]... [--recommend <A>] [--applied <A>]
                                   Start a thread as the agent, on a screen or one of its elements
  resolve <feature> <thread>       Resolve a thread you have read to the end
  status <feature>                 draft | approved | stale, open and unread threads
  watch                            Print one line per new comment or approval; read them with comments
  list                             List features in this project
  stop                             Stop the server
  hook [--stop]                    Claude Code UserPromptSubmit hook; with --stop, the Stop hook

Options: --project-dir <path> (default: current directory)
Rendering uses Chrome, Chromium, Edge or Brave; set DESIGN_FLOW_CHROME to choose one.
`;

/** Commands that tie their folder to the Claude Code session running them, so its hooks and monitor look there. */
const LINKING = new Set(["open", "check", "shot", "outline", "comments", "reply", "ask", "resolve", "status", "list"]);

export async function main(argv: string[]): Promise<number> {
  try {
    const a = parseArgs(argv);
    const cmd = a._[0];
    const dir = projectDir(a);
    if (cmd && LINKING.has(cmd) && (cmd === "open" || existsSync(join(dir, ".design-flow"))))
      try {
        linkSession(home(), sessionId(process.env.CLAUDE_CODE_SESSION_ID), dir);
      } catch {
        /* the link only helps the hooks find this folder; the command goes on without it */
      }
    switch (cmd) {
      case "open": {
        const f = feature(a);
        const fd = featureDir(dir, f);
        mkdirSync(fd, { recursive: true });
        const { info, key } = await register(dir);
        let created = false;
        if (!existsSync(join(fd, "flow.yaml"))) {
          writeFileSync(join(fd, "flow.yaml"), TEMPLATE(f, `http://127.0.0.1:${info.port}/schema/flow.v1.json`));
          if (!existsSync(join(fd, "prototype.html"))) writeFileSync(join(fd, "prototype.html"), PROTOTYPE(f));
          created = true;
        }
        const url = `http://127.0.0.1:${info.port}/p/${key}/${f}`;
        if (created) console.log(`Created ${join(".design-flow", f, "flow.yaml")} and prototype.html from the template.`);
        console.log(`Canvas: ${url}`);
        const code = check(dir, f);
        if (!a.flags["no-open"]) {
          const { default: open } = await import("open");
          await open(url).catch(() => console.log("Could not open a browser; open the URL above."));
        }
        return code === 3 ? 3 : 0;
      }
      case "check":
        return a.flags.visual ? await checkVisual(dir, feature(a)) : check(dir, feature(a));
      case "shot": {
        const f = feature(a);
        const { loadFeature, shot } = await import("./visual.ts");
        const scale = valueFlag(a, "scale");
        if (scale !== undefined && scale !== "1" && scale !== "2") throw new UsageError("--scale is 1 or 2");
        const opts = {
          screens: a._.slice(2),
          lanes: a.lists.lane ?? [],
          all: !!a.flags.all,
          sheet: !!a.flags.sheet,
          element: valueFlag(a, "element"),
          scale: scale ? Number(scale) : undefined,
          out: valueFlag(a, "out"),
          dir: valueFlag(a, "dir"),
        };
        for (const p of await shot(loadFeature(requireFeature(dir, f), f), opts, (m) => console.error(`design-flow: ${m}`))) console.log(p);
        return 0;
      }
      case "outline": {
        const f = feature(a);
        const fd = requireFeature(dir, f);
        const { loadFeature, outlineFlow, outlineScreen } = await import("./visual.ts");
        console.log(a._[2] ? await outlineScreen(loadFeature(fd, f), a._[2], !!a.flags.json) : outlineFlow(fd, f, !!a.flags.json));
        return 0;
      }
      case "comments": {
        const f = feature(a);
        const fd = requireFeature(dir, f);
        const flow = parseFlow(readFileSync(join(fd, "flow.yaml"), "utf8"), "").flow;
        const store = CommentStore.load(fd);
        const fresh = new Set(store.unread().map((d) => d.messageId));
        const threads = store.threads.filter((t) => !a.flags.unread || t.messages.some((m) => fresh.has(m.id)));
        const loc = locale();
        const where = (t: Thread) => (flow ? describeAnchor(t.anchor, flow, loc) : "");
        const located = (t: Thread) => where(t) + lineNote(t.anchor);
        // Shots first, so they print with their threads; without a browser the threads still print.
        let shots = new Map<string, { file?: string; note?: string }>();
        let sheets: string[] = [];
        if (a.flags.shots && threads.length)
          try {
            const { loadFeature, commentShots } = await import("./visual.ts");
            const r = await commentShots(loadFeature(fd, f), threads);
            shots = new Map(r.shots.map((s) => [s.thread, s]));
            sheets = r.sheets;
          } catch (e) {
            console.error(`design-flow: no shots: ${(e as Error).message}`);
          }
        if (a.flags.json)
          console.log(
            JSON.stringify(
              threads.map((t) => ({
                ...t,
                seen: seenCount(t),
                where: where(t),
                unread: t.messages.some((m) => fresh.has(m.id)),
                ...(shots.get(t.id)?.file ? { shot: shots.get(t.id)!.file } : {}),
              })),
              null,
              2,
            ),
          );
        else {
          if (!threads.length) console.log(a.flags.unread ? "No unread comments." : "No comments.");
          for (const t of threads) printThread(t, located(t), fresh, shots.get(t.id));
          if (sheets.length) console.log(`All of them on ${sheets.length === 1 ? "one sheet" : `${sheets.length} sheets`}: ${sheets.join(" ")}`);
        }
        // Printed, so read: only now, so that a run that dies first leaves them unread.
        store.markRead(threads.map((t) => t.id));
        return 0;
      }
      case "reply": {
        const f = feature(a);
        const id = a._[2];
        const text = a.flags.text;
        if (!id || typeof text !== "string" || !text.trim())
          throw new UsageError("usage: design-flow reply <feature> <thread> --text <text> [--option <text>]... [--recommend <A>] [--applied <A>]");
        const offer = offerOf(a);
        const store = CommentStore.load(requireFeature(dir, f));
        store.reply(id, "agent", text.trim(), offer);
        await notify(dir, f);
        console.log(`Replied to #${id}.`);
        // What the user added that the agent had not read: it reads it here, with its reply.
        const missed = store.unread().filter((d) => d.threadId === id);
        if (missed.length) {
          console.log("Before your reply the user also wrote, unread until now:");
          for (const d of missed) console.log(`  user: ${d.text}`);
        }
        store.markRead([id]);
        return 0;
      }
      case "ask": {
        const f = feature(a);
        const text = a.flags.text;
        const usage = "usage: design-flow ask <feature> <screen> --text <text> [--element <selector>] [--option <text>]... [--recommend <A>] [--applied <A>]";
        if (typeof text !== "string" || !text.trim()) throw new UsageError(usage);
        const offer = offerOf(a);
        const fd = requireFeature(dir, f);
        const { askAnchor, loadFeature, screenOf } = await import("./visual.ts");
        const feat = loadFeature(fd, f);
        const { anchor, count } = await askAnchor(feat, screenOf(feat.flow, a._[2], usage), valueFlag(a, "element"));
        const t = CommentStore.load(fd).ask(anchor, text.trim(), offer);
        await notify(dir, f);
        console.log(`Asked #${t.id} on ${describeAnchor(anchor, feat.flow, locale())}${lineNote(anchor)}.`);
        if (count > 1) console.log(`--element matched ${count} elements; the question is on the first.`);
        return 0;
      }
      case "resolve": {
        const f = feature(a);
        const id = a._[2];
        if (!id) throw new UsageError("usage: design-flow resolve <feature> <thread>");
        const store = CommentStore.load(requireFeature(dir, f));
        const missed = store.resolveIfRead(id);
        if (missed.length) {
          console.log(`Not resolved: the user wrote on #${id} after you last read it:`);
          for (const d of missed) console.log(`  user: ${d.text}`);
          console.log("Answer it, or run resolve again if it needs nothing more.");
          store.markRead([id]);
          return 1;
        }
        await notify(dir, f);
        console.log(`Resolved #${id}.`);
        return 0;
      }
      case "status": {
        const f = feature(a);
        const fd = requireFeature(dir, f);
        const s = approvalStatus(fd);
        const unread = new Set(CommentStore.load(fd).unread().map((d) => d.threadId)).size;
        console.log(
          `${s.status} · ${s.openThreads} open thread${s.openThreads === 1 ? "" : "s"}${unread ? ` (${unread} unread)` : ""}${s.approvedAt ? ` · approved ${s.approvedAt}` : ""}`,
        );
        // The agent has now been told of the approval.
        const shown = unseenApproval(fd);
        if (shown) markApprovalSeen(fd, shown);
        return 0;
      }
      case "list": {
        const root = join(dir, ".design-flow");
        const { readdirSync } = await import("node:fs");
        const names = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, "flow.yaml"))) : [];
        if (!names.length) console.log("No features yet. Start one with: design-flow open <feature>");
        for (const n of names.sort()) {
          const s = approvalStatus(join(root, n));
          const unread = new Set(CommentStore.load(join(root, n)).unread().map((d) => d.threadId)).size;
          console.log(`${n}\t${s.status}\t${s.openThreads} open${unread ? `\t${unread} unread` : ""}`);
        }
        return 0;
      }
      case "watch":
        return await watchEvents(dir);
      case "stop": {
        const info = await runningServer();
        if (!info) {
          console.log("No server running.");
          return 0;
        }
        try {
          process.kill(info.pid);
        } catch {
          /* already gone */
        }
        console.log("Stopped.");
        return 0;
      }
      case "hook": {
        const { hook, stopHook } = await import("./hook.ts");
        return a.flags.stop ? await stopHook(dir, await stdinJson()) : await hook(dir, await stdinJson());
      }
      case undefined:
      case "help":
      case "--help":
        console.log(HELP);
        return 0;
      default:
        throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (e) {
    console.error(`design-flow: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

/** The JSON a hook gets on stdin, or {} when there is none: a terminal, nothing within `ms`, or not JSON. */
async function stdinJson(ms = 2000): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const text = await new Promise<string>((done) => {
    let s = "";
    const end = () => {
      clearTimeout(timer);
      done(s);
    };
    const timer = setTimeout(end, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.once("end", end);
    process.stdin.once("error", end);
  });
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Ask a running server to push fresh state (file watching would catch it too; this is faster). */
async function notify(dir: string, f: string) {
  const info = await runningServer();
  if (!info) return;
  await fetch(`http://127.0.0.1:${info.port}/api/projects/${projectKey(dir)}/features/${f}`).catch(() => {});
}

/** How long watch collects comments after the first before it prints them together. */
const WATCH_BATCH_MS = 2000;
/** How often a watch looks for folders its session has started working on. */
const LINK_SCAN_MS = 2000;

function watchEvents(dir: string): Promise<number> {
  const session = sessionId(process.env.CLAUDE_CODE_SESSION_ID);
  const release = claimWatch(home(), session);
  if (release === false) {
    console.error("design-flow watch: this session already has a watch running, so this one ends");
    return Promise.resolve(0);
  }
  return new Promise((resolveExit) => {
    let stopped = false;
    // Only a watcher's first connect starts or replaces the server, as open does. A later connect attaches to whatever
    // server is up: a watcher left running across an update or a `stop` must not start its own build again. Waiting
    // loses nothing, because the server replays unread comments when a watcher connects.
    let starter = true;
    let starting: Promise<unknown> | undefined;
    let waiting = false;
    const sockets = new Set<WebSocket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      if (stopped) return;
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    // A user often leaves several comments in a row: they print as one batch, a line each.
    let batch: string[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(batchTimer);
      batchTimer = undefined;
      if (batch.length) console.log(batch.join("\n"));
      batch = [];
    };
    /** One folder's comments and approvals; a folder other than the session's own goes into the command to run. */
    const follow = (project: string, own: boolean) => {
      const elsewhere = own ? "" : ` --project-dir ${shellWord(project)}`;
      const connect = async () => {
        let info: ServerInfo;
        let key: string;
        try {
          if (starting) await starting.catch(() => {});
          let running: ServerInfo | undefined;
          if (!starter) {
            running = await runningServer();
            if (!running) {
              if (stopped) return;
              if (!waiting) console.error("design-flow watch: no server running; waiting for one (design-flow open starts it)");
              waiting = true;
              later(connect, 1500);
              return;
            }
          }
          const attempt = register(project, running);
          if (starter) starting = attempt;
          ({ info, key } = await attempt);
        } catch (e) {
          if (stopped) return;
          console.error(`design-flow watch: ${(e as Error).message}; retrying`);
          later(connect, 3000);
          return;
        }
        if (stopped) return;
        starter = false;
        waiting = false;
        const ws = new WebSocket(`ws://127.0.0.1:${info.port}/events?project=${key}`);
        sockets.add(ws);
        ws.on("message", (data) => {
          const m = JSON.parse(String(data));
          if (m.type === "comment") {
            batch.push(`[design-flow] ${m.feature} · ${m.first ? "new comment" : "reply"} #${m.thread} on ${m.where}: ${m.text} — run: design-flow comments ${m.feature} --shots${elsewhere}`);
            batchTimer ??= setTimeout(flush, WATCH_BATCH_MS);
          } else if (m.type === "approved")
            console.log(`[design-flow] ${m.feature} · APPROVED (flow.yaml ${String(m.sha256).slice(0, 8)}) — you may start coding this feature.`);
        });
        ws.on("close", () => {
          sockets.delete(ws);
          later(connect, 1500);
        });
        ws.on("error", () => {});
      };
      void connect();
    };
    // The session's own folder once it holds canvases (registering a folder gives it a .design-flow directory, so a
    // session opened elsewhere gets none), and each folder the session's commands link, as soon as they do.
    const followed = new Set<string>();
    const scan = () => {
      const mine = canonical(dir);
      if (!followed.has(mine) && existsSync(join(dir, ".design-flow"))) {
        followed.add(mine);
        follow(dir, true);
      }
      for (const p of linkedProjects(home(), session))
        if (!followed.has(p)) {
          followed.add(p);
          follow(p, false);
        }
    };
    const scanner = setInterval(scan, LINK_SCAN_MS);
    // SIGTERM or SIGINT ends the watch for good: no reconnect, and no socket or timer left to keep the process alive.
    const stop = () => {
      stopped = true;
      flush();
      clearInterval(scanner);
      for (const t of timers) clearTimeout(t);
      for (const ws of sockets) ws.terminate();
      release?.();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolveExit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    scan();
  });
}

export { DEFAULT_PORT };
