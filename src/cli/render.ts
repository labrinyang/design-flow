import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import WebSocket from "ws";
import type { Flow, Screen, Viewport } from "../core/flow.ts";
import { annotateLines } from "../core/lines.ts";
import { CSP } from "../core/play.ts";

const DEFAULT_VIEWPORT: Viewport = { width: 390, height: 844 };
/** The CSS px a screen is drawn at, as the canvas sizes its frame (viewportOf in web/src/screen-doc.ts); the flow's own without a screen. */
export const viewportOf = (flow: Flow, screen?: Screen): Viewport => screen?.viewport ?? flow.viewport ?? DEFAULT_VIEWPORT;

/**
 * One screen as a page of its own: the document of its canvas frame (screenDocument in web/src/screen-doc.ts)
 * without the frame script. Both mark every tag of a prototype.html section with its line; the frame counts
 * from the section's first line, this page in prototype.html.
 */
export function screenPage(flow: Flow, screen: Screen): string {
  const vp = viewportOf(flow, screen);
  const body = !screen.html?.trim()
    ? `<div data-empty style="display:flex;align-items:center;justify-content:center;height:100vh;font:14px system-ui;color:#888">${screen.id}</div>`
    : screen.htmlLine
      ? annotateLines(screen.html, screen.htmlLine)
      : screen.html;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=${vp.width}">
<style>html,body{margin:0;min-height:100%}</style>
${flow.style ?? ""}
</head><body>${body}</body></html>`;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where Chrome, Chromium, Edge and Brave usually live on this platform, then the same names on PATH. */
function browserPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const win = platform === "win32";
  const onPath = (names: string[]) =>
    (env.PATH ?? env.Path ?? "")
      .split(win ? ";" : ":")
      .filter(Boolean)
      .flatMap((d) => names.map((n) => (win ? win32.join(d, n) : join(d, n))));
  if (win) {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter((r): r is string => !!r);
    const exes = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ];
    return [...roots.flatMap((r) => exes.map((e) => win32.join(r, ...e))), ...onPath(["chrome.exe", "msedge.exe", "brave.exe"])];
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "brave"];
  if (platform !== "darwin") return onPath(names);
  const apps = ["Google Chrome", "Google Chrome Canary", "Chromium", "Microsoft Edge", "Brave Browser"];
  const roots = ["/Applications", join(homedir(), "Applications")];
  return [...roots.flatMap((r) => apps.map((a) => join(r, `${a}.app`, "Contents", "MacOS", a))), ...onPath(names)];
}

/** The browser to render with: DESIGN_FLOW_CHROME when it is set, else the first one installed. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const own = env.DESIGN_FLOW_CHROME;
  if (own) {
    if (isFile(own)) return own;
    throw new Error(`DESIGN_FLOW_CHROME is ${own}, which is not a file; point it at a Chrome, Chromium, Edge or Brave executable`);
  }
  const found = browserPaths(env, platform).find(isFile);
  if (!found) throw new Error("rendering screens needs Chrome, Chromium, Edge or Brave, and none was found; install one, or set DESIGN_FLOW_CHROME to its executable");
  return found;
}

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** The DevTools protocol over one WebSocket: calls answered by id, events to whoever listens. */
class Cdp {
  private seq = 0;
  private calls = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.receive(JSON.parse(String(data))));
    ws.on("close", () => {
      for (const c of this.calls.values()) {
        clearTimeout(c.timer);
        c.fail(new Error("the browser closed the connection"));
      }
      this.calls.clear();
    });
    ws.on("error", () => {});
  }

  send<T>(method: string, params: object = {}, sessionId?: string, ms = 30_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((done, fail) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        fail(new Error(`the browser did not answer ${method} within ${ms / 1000} s`));
      }, ms);
      this.calls.set(id, { done: done as (v: unknown) => void, fail, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (e) => {
        if (!e) return;
        clearTimeout(timer);
        this.calls.delete(id);
        fail(e);
      });
    });
  }

  private receive(m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }) {
    if (m.id === undefined) {
      if (m.method) for (const f of this.listeners) f({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      return;
    }
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    clearTimeout(c.timer);
    if (m.error) c.fail(new Error(m.error.message));
    else c.done(m.result);
  }
}

/** A region of the page in CSS px, from the top left of the document. */
export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One screen, rendered and settled. */
export interface Page {
  /** Runs `fn` in the page and returns what it returns; an argument that is a function arrives as one, from its source. */
  call<T>(fn: (...args: never[]) => T | Promise<T>, ...args: unknown[]): Promise<Awaited<T>>;
  /** A PNG of the viewport, or of `clip` within it. */
  screenshot(clip?: Clip): Promise<Buffer>;
  close(): Promise<void>;
}

export interface Browser {
  /** A new tab showing `html` at `viewport`, `scale` device px per CSS px, once fonts and animations have settled. */
  open(html: string, viewport: Viewport, scale: number): Promise<Page>;
  close(): Promise<void>;
}

const FLAGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--hide-scrollbars",
  "--mute-audio",
  "--force-color-profile=srgb",
  // No keychain or keyring prompt for the throwaway profile.
  "--use-mock-keychain",
  "--password-store=basic",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const source = (v: unknown) => (typeof v === "function" ? `(${v.toString()})` : v === undefined ? "undefined" : JSON.stringify(v));

/**
 * Starts a headless browser with a throwaway profile. Close it when done: that ends the process and removes the
 * profile. An interrupt (Ctrl-C, SIGTERM) does the same before the command exits.
 */
export async function launchBrowser(): Promise<Browser> {
  const exe = findBrowser();
  let profile: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const running = () => !!child && child.exitCode === null && child.signalCode === null;
  const removeProfile = () => profile && rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const killNow = () => {
    if (running()) child!.kill("SIGKILL");
  };
  const interrupted = (signal: NodeJS.Signals) => {
    killNow();
    try {
      removeProfile();
    } catch {
      /* the next run's temp dir is a new one */
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  // In place before the profile and the process exist, so no interrupt can come between and leave them behind.
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  process.once("exit", killNow);
  const release = () => {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    process.off("exit", killNow);
  };
  try {
    profile = mkdtempSync(join(tmpdir(), "design-flow-chrome-"));
    const args = [...FLAGS, `--user-data-dir=${profile}`];
    if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
    child = spawn(exe, [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    removeProfile();
    release();
    throw e;
  }
  const proc = child;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));

  let ws: WebSocket | undefined;
  let cdp: Cdp | undefined;
  const close = async () => {
    if (cdp) await cdp.send("Browser.close", {}, undefined, 3000).catch(() => {});
    ws?.terminate();
    if (running()) await Promise.race([exited, sleep(3000)]);
    killNow();
    if (running()) await Promise.race([exited, sleep(2000)]);
    removeProfile();
    release();
  };
  try {
    const endpoint = await devtoolsEndpoint(proc, exe);
    ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 1 << 30 });
    await new Promise<void>((done, fail) => {
      ws!.once("open", () => done());
      ws!.once("error", fail);
    });
    cdp = new Cdp(ws);
  } catch (e) {
    await close();
    throw e;
  }
  const connected = cdp;
  return { open: (html, viewport, scale) => openPage(connected, html, viewport, scale), close };
}

/** The browser's DevTools WebSocket, from the line it prints to stderr once it listens. */
function devtoolsEndpoint(child: ReturnType<typeof spawn>, exe: string): Promise<string> {
  return new Promise((done, fail) => {
    let err = "";
    const stop = (e?: Error, url?: string) => {
      clearTimeout(timer);
      child.stderr!.off("data", read);
      // Keep reading what it prints, or a full pipe would stall it.
      child.stderr!.resume();
      if (e) fail(e);
      else done(url!);
    };
    const read = (d: Buffer) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) stop(undefined, m[1]);
    };
    const timer = setTimeout(() => stop(new Error(`${exe} did not start within 30 s`)), 30_000);
    child.stderr!.on("data", read);
    child.once("error", (e) => stop(new Error(`could not start ${exe}: ${e.message}`)));
    child.once("exit", (code) => stop(new Error(`${exe} exited with code ${code} before it was ready: ${err.trim().split("\n").slice(-3).join(" ")}`)));
  });
}

async function openPage(cdp: Cdp, html: string, viewport: Viewport, scale: number): Promise<Page> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T>(method: string, params?: object) => cdp.send<T>(method, params, sessionId);
  // An alert() or confirm() in the prototype would hold the page until someone answers it.
  const onDialog = (e: CdpEvent) => {
    if (e.sessionId === sessionId && e.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
  };
  cdp.listeners.add(onDialog);
  const page: Page = {
    async call(fn, ...args) {
      const r = await send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
        expression: `(${fn.toString()})(${args.map(source).join(",")})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(`the screen's page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value as never;
    },
    async screenshot(clip) {
      const { data } = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      });
      return Buffer.from(data, "base64");
    },
    async close() {
      cdp.listeners.delete(onDialog);
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: scale, mobile: false });
    const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    await page.call(settle, 5000);
  } catch (e) {
    await page.close();
    throw e;
  }
  return page;
}

/**
 * In the page: waits for it to load, its fonts and two frames, then holds every animation still, a finite one at its
 * end and an endless one at its start, so each render of a screen looks the same.
 */
async function settle(ms: number) {
  const frames = () =>
    new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
      setTimeout(done, 500);
    });
  const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise((done) => addEventListener("load", done, { once: true }));
  await Promise.race([Promise.all([loaded, document.fonts.ready]), new Promise((done) => setTimeout(done, ms))]);
  await frames();
  for (const a of document.getAnimations()) {
    try {
      if (a.effect?.getComputedTiming().endTime === Infinity) {
        a.pause();
        a.currentTime = 0;
      } else a.finish();
    } catch {
      /* one that cannot finish, such as at playback rate 0, stays as it is */
    }
  }
  await frames();
}
