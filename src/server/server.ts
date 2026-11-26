import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimes, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { approvalStatus, approve, hashFlow, hashSpec, unseenApproval } from "../core/approval.ts";
import { CommentStore, describeAnchor, isOrphan, seenCount, type Anchor, type ElementAnchor, type Locale } from "../core/comments.ts";
import { parseFlow, type Flow, type Issue } from "../core/flow.ts";
import { layoutFlow } from "../core/layout.ts";
import { PICTURE_PATH, Pictures, type PictureSource } from "./thumbs.ts";
import { applyPrototype, checkPrototype, readPrototype } from "../core/prototype.ts";
import { shareDocument } from "../core/share.ts";

const execFileP = promisify(execFile);
import schema from "../../schema/flow.v1.json" with { type: "json" };

export const VERSION = "0.1.0";
/**
 * Identifies this exact build of the code, so a CLI from a newer build can tell an older server
 * still running in the background from its own and replace it.
 */
export const BUILD = createHash("sha1").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12);
export const DEFAULT_PORT = 27420;
const FEATURE_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface Server {
  port: number;
  close(): Promise<void>;
}
export interface ServerOptions {
  port?: number;
  home: string;
  webRoot?: string;
  locale?: Locale;
  /** The gh CLI used to publish share links; "gh" on PATH by default. */
  gh?: string;
  /** Draws pictures of screens for the canvas (see thumbs.ts); without one the canvas shows live frames only. */
  pictures?: PictureSource;
  log?: (message: string) => void;
}

interface Project {
  key: string;
  dir: string;
  watcher?: FSWatcher;
  lastValid: Map<string, Flow>;
}

/** Replace each `file:` screen with its HTML; a missing file becomes an issue. */
export function inlineScreens(flow: Flow | undefined, dir: string, flowFile: string, issues: Issue[]): Flow | undefined {
  if (!flow) return flow;
  return {
    ...flow,
    screens: flow.screens.map((s) => {
      if (!s.file) return s;
      const path = resolve(dir, s.file);
      if (!path.startsWith(resolve(dir) + "/") || !existsSync(path)) {
        issues.push({ file: flowFile, line: 1, col: 1, message: `screen ${s.id}: file ${s.file} not found`, hint: "Paths are relative to the feature directory." });
        return { ...s, html: "" };
      }
      return { ...s, html: readFileSync(path, "utf8") };
    }),
  };
}

export const projectKey = (dir: string) => createHash("sha1").update(resolve(dir)).digest("hex").slice(0, 10);
function validAnchor(a: unknown): a is Anchor {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  const pt = x.point as Record<string, unknown> | undefined;
  if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number" || !isFinite(pt.x) || !isFinite(pt.y)) return false;
  const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 200;
  switch (x.type) {
    case "element":
      return str(x.screen) && typeof x.selector === "string" && x.selector.length > 0 && x.selector.length < 500 && typeof x.tag === "string" && typeof x.text === "string" && x.text.length < 500;
    case "screen":
      return str(x.screen);
    case "edge": {
      const e = x.edge as Record<string, unknown> | undefined;
      return !!e && str(e.from) && str(e.to) && (e.index === undefined || Number.isInteger(e.index));
    }
    case "lane":
      return str(x.lane);
    case "canvas":
      return x.near === undefined || str(x.near);
    default:
      return false;
  }
}

const within = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/**
 * A new comment's anchor as it is stored, or undefined when a field it needs is missing or wrong. An element
 * anchor's optional fields (box, offset, near, line) are kept only when they make sense; one that does not is
 * dropped, and the comment still goes in.
 */
export function cleanAnchor(a: unknown): Anchor | undefined {
  if (!validAnchor(a)) return undefined;
  if (a.type !== "element") return a;
  const { box, offset, near, line, ...rest } = a;
  const out: ElementAnchor = rest;
  const b = record(box);
  if (b && within(b.x, -1e5, 1e5) && within(b.y, -1e5, 1e5) && within(b.width, 0, 1e5) && within(b.height, 0, 1e5))
    out.box = { x: b.x, y: b.y, width: b.width, height: b.height };
  const o = record(offset);
  if (o && within(o.x, 0, 1) && within(o.y, 0, 1)) out.offset = { x: o.x, y: o.y };
  if (typeof near === "string" && near.trim() && near.length <= 120) out.near = near;
  if (Number.isInteger(line) && within(line, 1, 1e7)) out.line = line;
  return out;
}

const featuresRoot = (p: Project) => join(p.dir, ".design-flow");
const featureDir = (p: Project, f: string) => join(featuresRoot(p), f);

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function body(req: IncomingMessage): Promise<any> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
    throw new HttpError(415, "requests with a body must be application/json");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  for (let p = port, tries = 0; tries < 20; tries++, p = port === 0 ? 0 : p + 1) {
    const ok = await new Promise<boolean>((res, rej) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.off("listening", onOk);
        if (e.code === "EADDRINUSE") res(false);
        else rej(e);
      };
      const onOk = () => {
        server.off("error", onErr);
        res(true);
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(p, "127.0.0.1");
    });
    if (ok) return (server.address() as { port: number }).port;
  }
  throw new Error(`no free port from ${port}`);
}

export async function startServer(opts: ServerOptions): Promise<Server> {
  const home = opts.home;
  mkdirSync(home, { recursive: true });
  const locale = opts.locale ?? "en";
  const projects = new Map<string, Project>();
  const featureSockets = new Map<string, Set<WebSocket>>(); // `${key}/${feature}`
  const eventSockets = new Map<string, Set<WebSocket>>(); // key
  const debounce = new Map<string, NodeJS.Timeout>();

  /** Pictures drawn since the last send, by `key/feature`, then screen; sent to that feature's canvases in batches. */
  const drawn = new Map<string, Record<string, string>>();
  let drawnTimer: NodeJS.Timeout | undefined;
  const sendDrawn = () => {
    drawnTimer = undefined;
    for (const [k, thumbs] of drawn) for (const ws of featureSockets.get(k) ?? []) send(ws, { type: "thumbs", thumbs });
    drawn.clear();
  };
  const pictures = opts.pictures
    ? new Pictures(
        join(home, "thumbs"),
        opts.pictures,
        (_key, url, tokens) => {
          for (const token of tokens) {
            const cut = token.lastIndexOf("/");
            const k = token.slice(0, cut);
            drawn.set(k, { ...drawn.get(k), [token.slice(cut + 1)]: url });
          }
          drawnTimer ??= setTimeout(sendDrawn, 250);
        },
        (e) => {
          opts.log?.(`picture: ${e.message.split("\n")[0]}`);
          // No browser to draw with: canvases show every screen as a live page instead. Told a moment later, after
          // the state being sent now, which may still say pictures are coming.
          if ((e as Error & { launch?: boolean }).launch)
            setTimeout(() => {
              for (const set of featureSockets.values()) for (const ws of set) send(ws, { type: "pictures", on: false });
            }, 250).unref();
        },
      )
    : undefined;

  const persist = () =>
    writeFileSync(join(home, "projects.json"), JSON.stringify([...projects.values()].map((p) => p.dir), null, 2));

  function featureNames(p: Project): string[] {
    const root = featuresRoot(p);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((n) => FEATURE_RE.test(n) && existsSync(join(root, n, "flow.yaml")))
      .sort();
  }

  function checkFeature(p: Project, f: string) {
    if (!FEATURE_RE.test(f)) throw new HttpError(400, `invalid feature name "${f}"`);
    const dir = featureDir(p, f);
    if (!existsSync(join(dir, "flow.yaml"))) throw new HttpError(404, `no flow.yaml for feature "${f}"`);
    return dir;
  }

  async function state(p: Project, f: string) {
    const dir = checkFeature(p, f);
    const file = join(dir, "flow.yaml");
    const text = readFileSync(file, "utf8");
    const parsed = parseFlow(text, file);
    const lastFile = join(dir, ".last-valid.yaml");
    if (parsed.flow) {
      p.lastValid.set(f, parsed.flow);
      if (!existsSync(lastFile) || readFileSync(lastFile, "utf8") !== text) writeFileSync(lastFile, text);
    } else if (!p.lastValid.has(f) && existsSync(lastFile)) {
      const prev = parseFlow(readFileSync(lastFile, "utf8"), lastFile).flow;
      if (prev) p.lastValid.set(f, prev);
    }
    const issues: Issue[] = [...parsed.issues];
    const protoFile = join(dir, "prototype.html");
    const prototype = existsSync(protoFile) ? readFileSync(protoFile, "utf8") : undefined;
    let flow = inlineScreens(parsed.flow ?? p.lastValid.get(f), dir, file, issues);
    if (flow && prototype !== undefined) {
      const proto = readPrototype(prototype);
      if (parsed.flow) issues.push(...checkPrototype(proto, parsed.flow, protoFile));
      flow = applyPrototype(flow, proto);
    }
    const layout = flow ? await layoutFlow(flow) : undefined;
    const threads = CommentStore.load(dir).threads.map((t) => ({
      ...t,
      seen: seenCount(t),
      where: flow ? describeAnchor(t.anchor, flow, locale) : "",
      orphan: flow ? isOrphan(t.anchor, flow) : false,
    }));
    return {
      project: p.key,
      feature: f,
      flow,
      layout,
      /** Pictures of the screens drawn so far, by screen id; the rest arrive in "thumbs" messages as they are drawn. */
      thumbs: pictures && flow && layout ? pictures.forFlow(flow, layout, `${p.key}/${f}`) : {},
      /** Whether pictures are drawn at all; without them the canvas shows every screen live. */
      pictures: !!pictures?.available,
      issues,
      sha256: hashFlow(text, prototype),
      threads,
      status: approvalStatus(dir),
    };
  }

  /** prototype.html as written, when the feature has one: the whole interactive document, for Play and sharing. */
  function prototypeOf(p: Project, f: string): string | undefined {
    const file = join(checkFeature(p, f), "prototype.html");
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  async function shareHtml(p: Project, f: string): Promise<string> {
    const s = await state(p, f);
    if (!s.flow) throw new HttpError(409, "flow.yaml has no valid version to share yet");
    const ids = new Set(s.flow.edges.map((e) => e.to));
    const start = (s.flow.screens.find((x) => !x.lane && !ids.has(x.id)) ?? s.flow.screens.find((x) => !ids.has(x.id)) ?? s.flow.screens[0]).id;
    return shareDocument(s.flow, prototypeOf(p, f), { start });
  }

  /** Publish the share page as a secret gist with the user's own gh login; returns the gist and a link that renders it. */
  async function publishGist(f: string, html: string): Promise<{ gist: string; url: string }> {
    const tmp = mkdtempSync(join(tmpdir(), "df-share-"));
    const file = join(tmp, `${f}.html`);
    writeFileSync(file, html);
    try {
      const { stdout } = await execFileP(opts.gh ?? "gh", ["gist", "create", file, "--desc", `Design Flow · ${f}`], { timeout: 60_000 });
      const gist = stdout.trim().split(/\s+/).find((w) => /^https:\/\/gist\.github\.com\//.test(w));
      if (!gist) throw new Error(`gh did not print a gist URL: ${stdout.trim()}`);
      // githack serves the raw file as text/html from a CDN; viewers need no GitHub API quota or login.
      const [owner, id] = new URL(gist).pathname.split("/").filter(Boolean);
      return { gist, url: `https://gistcdn.githack.com/${owner}/${id}/raw/${f}.html` };
    } catch (e) {
      throw new HttpError(502, `Could not create the gist (${(e as Error).message.split("\n")[0]}). Install the GitHub CLI and run gh auth login, then try again.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const send = (ws: WebSocket, m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  async function pushState(p: Project, f: string) {
    const socks = featureSockets.get(`${p.key}/${f}`);
    if (!socks?.size) return;
    try {
      const s = await state(p, f);
      for (const ws of socks) send(ws, { type: "state", state: s });
    } catch {
      /* feature removed */
    }
  }

  /** What each events socket has been sent, by key, so a watcher hears of each message once per connection. */
  const pushed = new WeakMap<WebSocket, Set<string>>();

  /**
   * Ring the agent's watchers: send each one the unread comments and the unseen approval it has not been sent
   * yet. Sending marks nothing read, since a watcher's output may reach no agent (a plain background shell
   * reports only when it exits); what counts is the text `comments` or the prompt hook prints to the agent.
   * So a watcher that connects again hears of whatever is still unread.
   */
  function deliver(p: Project) {
    const socks = [...(eventSockets.get(p.key) ?? [])].filter((s) => s.readyState === s.OPEN);
    if (!socks.length) return;
    for (const f of featureNames(p)) {
      const dir = featureDir(p, f);
      const flow = p.lastValid.get(f) ?? parseFlow(readFileSync(join(dir, "flow.yaml"), "utf8"), "").flow;
      const events: [key: string, message: unknown][] = CommentStore.load(dir)
        .unread()
        .map((d) => [
          `${f}/${d.threadId}/${d.messageId}`,
          { type: "comment", feature: f, thread: d.threadId, first: d.first, text: d.text, where: flow ? describeAnchor(d.anchor, flow, locale) : "" },
        ]);
      const a = unseenApproval(dir);
      if (a) events.push([`${f}/approval/${a.at}`, { type: "approved", feature: f, sha256: a.sha256, at: a.at }]);
      for (const ws of socks) {
        let sent = pushed.get(ws);
        if (!sent) pushed.set(ws, (sent = new Set()));
        for (const [k, m] of events)
          if (!sent.has(k)) {
            sent.add(k);
            send(ws, m);
          }
      }
    }
  }

  function onChange(p: Project, f: string) {
    const k = `${p.key}/${f}`;
    clearTimeout(debounce.get(k));
    debounce.set(
      k,
      setTimeout(() => {
        debounce.delete(k);
        void pushState(p, f);
        // With no canvas open, still queue pictures of what changed, so they are ready when one opens.
        if (pictures && !featureSockets.get(k)?.size) void state(p, f).catch(() => {});
        deliver(p);
      }, 80),
    );
  }

  function register(dir: string): Project {
    const abs = resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new HttpError(400, `not a directory: ${abs}`);
    const key = projectKey(abs);
    let p = projects.get(key);
    if (p) return p;
    p = { key, dir: abs, lastValid: new Map() };
    mkdirSync(featuresRoot(p), { recursive: true });
    const proj = p;
    p.watcher = watch(featuresRoot(p), { recursive: true }, (_e, name) => {
      const f = String(name ?? "").split(/[\\/]/)[0];
      if (FEATURE_RE.test(f)) onChange(proj, f);
    });
    projects.set(key, p);
    persist();
    return p;
  }

  for (const dir of readJson<string[]>(join(home, "projects.json"), []))
    try {
      register(dir);
    } catch {
      /* project gone */
    }

  const getProject = (key: string) => {
    const p = projects.get(key);
    if (!p) throw new HttpError(404, `unknown project ${key}`);
    return p;
  };

  async function api(req: IncomingMessage, res: ServerResponse, parts: string[]) {
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const m = req.method ?? "GET";
    // /api/projects
    if (parts.length === 1 && parts[0] === "projects") {
      if (m === "POST") {
        const p = register((await body(req)).dir);
        return reply(200, { key: p.key, dir: p.dir });
      }
      return reply(
        200,
        [...projects.values()].map((p) => ({
          key: p.key,
          dir: p.dir,
          features: featureNames(p).map((name) => ({ name, ...approvalStatus(featureDir(p, name)) })),
        })),
      );
    }
    if (parts[0] !== "projects" || !parts[1]) throw new HttpError(404, "not found");
    const p = getProject(parts[1]);
    if (parts.length === 2)
      return reply(200, {
        key: p.key,
        dir: p.dir,
        features: featureNames(p).map((name) => ({ name, ...approvalStatus(featureDir(p, name)) })),
      });
    if (parts[2] !== "features" || !parts[3]) throw new HttpError(404, "not found");
    const f = parts[3];
    const dir = checkFeature(p, f);
    const action = parts[4];
    if (!action && m === "GET") return reply(200, await state(p, f));
    // Play asks for the whole document when it opens, so the state the canvas gets on every change stays small.
    if (action === "prototype" && m === "GET") return reply(200, { prototype: prototypeOf(p, f) ?? null });
    if (action === "share.html" && m === "GET") {
      res.writeHead(200, { "content-type": MIME[".html"], "content-disposition": `attachment; filename="${f}.html"` });
      res.end(await shareHtml(p, f));
      return;
    }
    if (action === "share" && m === "POST") return reply(200, await publishGist(f, await shareHtml(p, f)));
    if (action === "approve" && m === "POST") {
      const b = (await body(req)) as { sha256?: string };
      const text = readFileSync(join(dir, "flow.yaml"), "utf8");
      if (!b.sha256 || b.sha256 !== hashSpec(dir))
        throw new HttpError(409, "flow.yaml or prototype.html changed since the canvas was drawn; review the new version and approve again");
      if (parseFlow(text, "").issues.length) throw new HttpError(409, "flow.yaml has problems; it cannot be approved until check is clean");
      approve(dir);
    } else if (action === "comments" && m === "POST") {
      const b = (await body(req)) as { anchor: unknown; text: unknown };
      if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "empty comment");
      const anchor = cleanAnchor(b.anchor);
      if (!anchor) throw new HttpError(400, "invalid comment anchor");
      CommentStore.load(dir).addThread(anchor, b.text.trim());
    } else if (action === "threads" && parts[5] && m === "POST") {
      const op = parts[6];
      const b = op === "reply" || op === "pick" ? await body(req) : {};
      const s = CommentStore.load(dir);
      try {
        if (op === "reply") s.reply(parts[5], b.author === "agent" ? "agent" : "user", String(b.text ?? ""));
        else if (op === "pick") s.pick(parts[5], String(b.message ?? ""), Number(b.option));
        else if (op === "resolve") s.resolve(parts[5]);
        else if (op === "reopen") s.reopen(parts[5]);
        else throw new HttpError(404, "not found");
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(e instanceof RangeError ? 400 : 404, (e as Error).message);
      }
    } else throw new HttpError(404, "not found");
    onChange(p, f);
    return reply(200, await state(p, f));
  }

  const webRoot = opts.webRoot;
  function serveStatic(url: string, res: ServerResponse) {
    if (!webRoot) {
      res.writeHead(404).end("web app not built");
      return;
    }
    let file = resolve(webRoot, "." + url);
    if (!file.startsWith(resolve(webRoot)) || !existsSync(file) || statSync(file).isDirectory())
      file = join(webRoot, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  let port = 0;
  /** Only the canvas itself (same origin) and local tools without an Origin may talk to the server. */
  function trusted(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }
  const fail = (res: ServerResponse, status: number, error: string) => {
    if (res.headersSent) return res.end();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  };

  const http = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      fail(res, e instanceof HttpError ? e.status : 500, (e as Error).message);
    }
  });

  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? "/";
    if (!trusted(req)) return fail(res, 403, "forbidden");
    let path: string;
    try {
      path = decodeURIComponent(url.split("?")[0]);
    } catch {
      return fail(res, 400, "malformed URL");
    }
    if (url.startsWith("/api/")) {
      let parts: string[];
      try {
        parts = url.split("?")[0].slice(5).split("/").map(decodeURIComponent);
      } catch {
        return fail(res, 400, "malformed URL");
      }
      api(req, res, parts).catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
      return;
    }
    const picture = PICTURE_PATH.exec(path);
    if (picture) {
      const file = pictures?.file(picture[1]);
      if (!file || !existsSync(file)) return fail(res, 404, "no such picture");
      // Named by what they show, so a picture never changes.
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" });
      res.end(readFileSync(file));
      const now = new Date();
      // Kept while in use: unused ones are deleted after a month (thumbs.ts).
      utimes(file, now, now, () => {});
      return;
    }
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, app: "design-flow", version: VERSION, build: BUILD }));
      return;
    }
    if (path === "/schema/flow.v1.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(schema, null, 2));
      return;
    }
    serveStatic(path, res);
  }

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (!trusted(req)) {
      socket.destroy();
      return;
    }
    let u: URL;
    try {
      u = new URL(req.url ?? "/", "http://x");
    } catch {
      socket.destroy();
      return;
    }
    const p = projects.get(u.searchParams.get("project") ?? "");
    if (!p || (u.pathname !== "/ws" && u.pathname !== "/events")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (u.pathname === "/events") {
        const set = eventSockets.get(p.key) ?? new Set();
        set.add(ws);
        eventSockets.set(p.key, set);
        ws.on("close", () => set.delete(ws));
        deliver(p);
        return;
      }
      const f = u.searchParams.get("feature") ?? "";
      const k = `${p.key}/${f}`;
      const set = featureSockets.get(k) ?? new Set();
      set.add(ws);
      featureSockets.set(k, set);
      ws.on("close", () => set.delete(ws));
      state(p, f).then(
        (s) => send(ws, { type: "state", state: s }),
        (e: Error) => send(ws, { type: "error", message: e.message }),
      );
    });
  });

  port = await listen(http, opts.port ?? DEFAULT_PORT);
  writeFileSync(join(home, "server.json"), JSON.stringify({ pid: process.pid, port, version: VERSION, build: BUILD }, null, 2));

  return {
    port,
    async close() {
      for (const p of projects.values()) p.watcher?.close();
      for (const t of debounce.values()) clearTimeout(t);
      clearTimeout(drawnTimer);
      await pictures?.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
