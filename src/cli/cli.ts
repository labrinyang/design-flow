import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { approvalStatus } from "../core/approval.ts";
import { CommentStore, describeAnchor, type Locale } from "../core/comments.ts";
import { parseFlow } from "../core/flow.ts";
import { checkPrototype, readPrototype } from "../core/prototype.ts";
import { BUILD, DEFAULT_PORT, projectKey, VERSION } from "../server/server.ts";
import { PROTOTYPE, TEMPLATE } from "./template.ts";

declare const __DESIGN_FLOW_BUNDLE__: boolean | undefined;
const FEATURE_RE = /^[a-z0-9][a-z0-9-]*$/;
export const home = () => process.env.DESIGN_FLOW_HOME ?? join(homedir(), ".design-flow");
const locale = (): Locale =>
  (process.env.DESIGN_FLOW_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale).startsWith("zh") ? "zh" : "en";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && ["text", "project-dir"].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

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

function check(dir: string, f: string): number {
  const fd = requireFeature(dir, f);
  const file = join(fd, "flow.yaml");
  const { flow, issues } = parseFlow(readFileSync(file, "utf8"), file);
  const proto = join(fd, "prototype.html");
  if (flow && existsSync(proto)) issues.push(...checkPrototype(readPrototype(readFileSync(proto, "utf8")), flow, proto));
  if (!issues.length) {
    console.log(`${f}: clean`);
    return 0;
  }
  printIssues(issues, dir);
  return 3;
}

const HELP = `design-flow ${VERSION} — UX flow canvas for coding agents

Usage: design-flow <command> [feature] [options]

  open <feature> [--no-open]       Start the server, create flow.yaml if missing, open the canvas
  check <feature>                  Validate flow.yaml (exit 0 clean, 3 issues)
  comments <feature> [--unread] [--json]
                                   Show comment threads; marks them delivered
  reply <feature> <thread> --text  Reply as the agent
  resolve <feature> <thread>       Resolve a thread
  status <feature>                 draft | approved | stale, and open threads
  watch                            Print one line per new comment or approval
  list                             List features in this project
  stop                             Stop the server
  hook                             Claude Code UserPromptSubmit hook

Options: --project-dir <path> (default: current directory)
`;

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const dir = projectDir(a);
  try {
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
        return check(dir, feature(a));
      case "comments": {
        const f = feature(a);
        const fd = requireFeature(dir, f);
        const flow = parseFlow(readFileSync(join(fd, "flow.yaml"), "utf8"), "").flow;
        const store = CommentStore.load(fd);
        const fresh = new Set(store.takeUndelivered().map((d) => d.messageId));
        const threads = store.threads.filter((t) => !a.flags.unread || t.messages.some((m) => fresh.has(m.id)));
        const loc = locale();
        if (a.flags.json) {
          console.log(
            JSON.stringify(
              threads.map((t) => ({ ...t, where: flow ? describeAnchor(t.anchor, flow, loc) : "", unread: t.messages.some((m) => fresh.has(m.id)) })),
              null,
              2,
            ),
          );
          return 0;
        }
        if (!threads.length) console.log(a.flags.unread ? "No unread comments." : "No comments.");
        for (const t of threads) {
          console.log(`#${t.id} [${t.status}] ${flow ? describeAnchor(t.anchor, flow, loc) : ""}`);
          for (const m of t.messages) console.log(`  ${m.author === "agent" ? "agent" : "user "}${fresh.has(m.id) ? " (new)" : ""}: ${m.text}`);
        }
        return 0;
      }
      case "reply": {
        const f = feature(a);
        const id = a._[2];
        const text = a.flags.text;
        if (!id || typeof text !== "string" || !text.trim()) throw new UsageError("usage: design-flow reply <feature> <thread> --text <text>");
        CommentStore.load(requireFeature(dir, f)).reply(id, "agent", text.trim());
        await notify(dir, f);
        console.log(`Replied to #${id}.`);
        return 0;
      }
      case "resolve": {
        const f = feature(a);
        const id = a._[2];
        if (!id) throw new UsageError("usage: design-flow resolve <feature> <thread>");
        CommentStore.load(requireFeature(dir, f)).resolve(id);
        await notify(dir, f);
        console.log(`Resolved #${id}.`);
        return 0;
      }
      case "status": {
        const f = feature(a);
        const s = approvalStatus(requireFeature(dir, f));
        console.log(`${s.status} · ${s.openThreads} open thread${s.openThreads === 1 ? "" : "s"}${s.approvedAt ? ` · approved ${s.approvedAt}` : ""}`);
        return 0;
      }
      case "list": {
        const root = join(dir, ".design-flow");
        const { readdirSync } = await import("node:fs");
        const names = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, "flow.yaml"))) : [];
        if (!names.length) console.log("No features yet. Start one with: design-flow open <feature>");
        for (const n of names.sort()) {
          const s = approvalStatus(join(root, n));
          console.log(`${n}\t${s.status}\t${s.openThreads} open`);
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
        const { hook } = await import("./hook.ts");
        return await hook(dir);
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

/** Ask a running server to push fresh state (file watching would catch it too; this is faster). */
async function notify(dir: string, f: string) {
  const info = await runningServer();
  if (!info) return;
  await fetch(`http://127.0.0.1:${info.port}/api/projects/${projectKey(dir)}/features/${f}`).catch(() => {});
}

function watchEvents(dir: string): Promise<number> {
  return new Promise((resolveExit) => {
    let stopped = false;
    let first = true;
    let waiting = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      if (!stopped) retry = setTimeout(connect, ms);
    };
    const connect = async () => {
      let info: ServerInfo;
      let key: string;
      try {
        // The first connect starts or replaces the server, as open does. A reconnect only attaches to whatever server is
        // up: a watcher left running across an update or a `stop` must not start its own build again. Waiting loses
        // nothing, because the server replays undelivered comments when a watcher connects.
        const running = first ? undefined : await runningServer();
        if (!first && !running) {
          if (stopped) return;
          if (!waiting) console.error("design-flow watch: no server running; waiting for one (design-flow open starts it)");
          waiting = true;
          again(1500);
          return;
        }
        ({ info, key } = await register(dir, running));
      } catch (e) {
        if (stopped) return;
        console.error(`design-flow watch: ${(e as Error).message}; retrying`);
        again(3000);
        return;
      }
      if (stopped) return;
      first = false;
      waiting = false;
      const ws = new WebSocket(`ws://127.0.0.1:${info.port}/events?project=${key}`);
      socket = ws;
      ws.on("message", (data) => {
        const m = JSON.parse(String(data));
        if (m.type === "comment")
          console.log(
            `[design-flow] ${m.feature} · ${m.first ? "new comment" : "reply"} #${m.thread} on ${m.where}: ${m.text} — run: design-flow comments ${m.feature}`,
          );
        else if (m.type === "approved")
          console.log(`[design-flow] ${m.feature} · APPROVED (flow.yaml ${String(m.sha256).slice(0, 8)}) — you may start coding this feature.`);
      });
      ws.on("close", () => again(1500));
      ws.on("error", () => {});
    };
    // SIGTERM or SIGINT ends the watch for good: no reconnect, and no socket or timer left to keep the process alive.
    const stop = () => {
      stopped = true;
      clearTimeout(retry);
      socket?.terminate();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolveExit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    void connect();
  });
}

export { DEFAULT_PORT };
