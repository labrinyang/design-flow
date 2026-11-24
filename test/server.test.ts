import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type Server } from "../src/server/server.ts";

const FLOW = `version: 1
title: Demo
screens:
  - { id: A, title: Alpha }
  - { id: B, title: Beta }
edges:
  - { from: A, to: B, label: go }
`;

let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), "df-proj-"));
  mkdirSync(join(dir, ".design-flow", "demo"), { recursive: true });
  writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), FLOW);
  return dir;
}

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "df-home-"));
  server = await startServer({ port: 0, home });
  return { home, base: `http://127.0.0.1:${server.port}` };
}

async function json(res: Response) {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function nextMessage(ws: WebSocket, pred: (m: any) => boolean, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), ms);
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (pred(m)) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
}

describe("server", () => {
  it("records itself in server.json", async () => {
    const { home } = await boot();
    const info = JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
    expect(info).toMatchObject({ port: server!.port, pid: process.pid });
  });

  it("returns a feature's flow, layout, issues and status", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const state = await json(await fetch(`${base}/api/projects/${key}/features/demo`));
    expect(state.flow.title).toBe("Demo");
    expect(state.issues).toEqual([]);
    expect(Object.keys(state.layout.screens).sort()).toEqual(["A", "B"]);
    expect(state.status.status).toBe("draft");
    const list = await json(await fetch(`${base}/api/projects/${key}`));
    expect(list.features.map((f: { name: string }) => f.name)).toEqual(["demo"]);
  });

  it("rejects feature names that escape the project", async () => {
    const { base } = await boot();
    const { key } = await json(await post(`${base}/api/projects`, { dir: project() }));
    const res = await fetch(`${base}/api/projects/${key}/features/..%2F..%2Fetc`);
    expect(res.status).toBe(400);
  });

  it("sends a watcher each unread comment once, sends it again to a new watcher, and stops once the agent read it", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const events = () => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/events?project=${key}`);
      const got: any[] = [];
      ws.on("message", (d) => got.push(JSON.parse(String(d))));
      return { ws, got, open: new Promise((r) => ws.on("open", r)) };
    };
    const one = events();
    await one.open;
    const first = nextMessage(one.ws, (m) => m.type === "comment");
    await json(
      await post(`${base}/api/projects/${key}/features/demo/comments`, {
        anchor: { type: "screen", screen: "A", point: { x: 1, y: 2 } },
        text: "Needs a back button",
      }),
    );
    expect(await first).toMatchObject({ feature: "demo", text: "Needs a back button", where: "Screen A Alpha" });
    // Unrelated changes ring again, but a connection hears of each message once.
    writeFileSync(join(dir, ".design-flow", "demo", "layout.json"), "{}");
    await new Promise((r) => setTimeout(r, 400));
    expect(one.got.filter((m) => m.type === "comment")).toHaveLength(1);
    // Sending it was not reading it: a watcher that connects now is told too.
    const two = events();
    await nextMessage(two.ws, (m) => m.type === "comment" && m.text === "Needs a back button");
    const threads = JSON.parse(readFileSync(join(dir, ".design-flow", "demo", "comments.json"), "utf8")).threads;
    expect(threads[0].seen).toBe(0);
    // Once the agent has read it, nobody is told again.
    const { CommentStore } = await import("../src/core/comments.ts");
    const store = CommentStore.load(join(dir, ".design-flow", "demo"));
    store.markRead([threads[0].id]);
    const three = events();
    await three.open;
    await new Promise((r) => setTimeout(r, 400));
    expect(three.got.filter((m) => m.type === "comment")).toEqual([]);
    for (const e of [one, two, three]) e.ws.close();
  });

  it("records a pick of an agent's option as the user's reply, and reports what the agent has read", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const f = `${base}/api/projects/${key}/features/demo`;
    const s0 = await json(await post(`${f}/comments`, { anchor: { type: "screen", screen: "A", point: { x: 1, y: 2 } }, text: "Claim where?" }));
    const id = s0.threads[0].id;
    expect(s0.threads[0].seen).toBe(0);
    const { CommentStore } = await import("../src/core/comments.ts");
    const store = CommentStore.load(join(dir, ".design-flow", "demo"));
    store.markRead([id]);
    const offer = store.reply(id, "agent", "Two ways", { options: ["One for the LP", "One per reward"], recommended: 0 });
    expect((await post(`${f}/threads/${id}/pick`, { message: offer.id, option: 5 })).status).toBe(400);
    expect((await post(`${f}/threads/${id}/pick`, { message: "nope", option: 0 })).status).toBe(400);
    const s1 = await json(await post(`${f}/threads/${id}/pick`, { message: offer.id, option: 1 }));
    expect(s1.threads[0].messages.at(-1)).toMatchObject({ author: "user", text: "One per reward", pick: { message: offer.id, option: 1 } });
    expect(s1.threads[0].seen).toBe(1);
  });

  it("pushes an update to the feature socket when flow.yaml changes", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?project=${key}&feature=demo`);
    await nextMessage(ws, (m) => m.type === "state");
    const updated = nextMessage(ws, (m) => m.type === "state" && m.state.flow?.title === "Changed", 1500);
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), FLOW.replace("Demo", "Changed"));
    expect((await updated).state.layout.screens.A).toBeTruthy();
    ws.close();
  });

  it("keeps the last valid flow when the file becomes invalid", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    await json(await fetch(`${base}/api/projects/${key}/features/demo`));
    await server!.close();
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), "version: 1\ntitle: [broken\n");
    const home2 = mkdtempSync(join(tmpdir(), "df-home-"));
    server = await startServer({ port: 0, home: home2 });
    const base2 = `http://127.0.0.1:${server.port}`;
    await json(await post(`${base2}/api/projects`, { dir }));
    const state = await json(await fetch(`${base2}/api/projects/${key}/features/demo`));
    expect(state.flow.title).toBe("Demo");
    expect(state.issues.length).toBeGreaterThan(0);
  });

  it("saves dragged positions and approves", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const f = `${base}/api/projects/${key}/features/demo`;
    await json(await post(`${f}/layout`, { A: { x: 900, y: 900 } }));
    expect((await json(await fetch(f))).layout.screens.A).toMatchObject({ x: 900, pinned: true });
    await json(await fetch(`${f}/layout`, { method: "DELETE" }));
    expect((await json(await fetch(f))).layout.screens.A.pinned).toBe(false);
    await json(await post(`${f}/approve`, { sha256: (await json(await fetch(f))).sha256 }));
    expect((await json(await fetch(f))).status.status).toBe("approved");
  });
});

describe("server hardening", () => {
  it("answers 400 to a malformed URL and keeps running", async () => {
    const { base } = await boot();
    const r1 = await fetch(`${base}/%E0%A4%A`);
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${base}/api/projects/%E0%A4%A`);
    expect(r2.status).toBe(400);
    expect((await fetch(`${base}/health`)).ok).toBe(true);
  });

  it("rejects cross-origin and non-JSON writes", async () => {
    const { base } = await boot();
    const dir = project();
    const evil = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ dir }),
    });
    expect(evil.status).toBe(403);
    const plain = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ dir }) });
    expect(plain.status).toBe(415);
    const own = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ dir }),
    });
    expect(own.status).toBe(200);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { base } = await boot();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: "/api/projects", headers: { host: "attacker.example" } }, (res) => resolve(res.statusCode!)).end();
    });
    expect(status).toBe(403);
  });

  it("refuses cross-origin WebSocket upgrades", async () => {
    const { base } = await boot();
    const { key } = await json(await post(`${base}/api/projects`, { dir: project() }));
    const ws = new WebSocket(`${base.replace("http", "ws")}/events?project=${key}`, { origin: "https://evil.example" });
    const outcome = await new Promise((r) => {
      ws.on("open", () => r("open"));
      ws.on("error", () => r("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("rejects a comment without a valid anchor", async () => {
    const { base } = await boot();
    const { key } = await json(await post(`${base}/api/projects`, { dir: project() }));
    const r = await post(`${base}/api/projects/${key}/features/demo/comments`, { anchor: { type: "screen", screen: "A" }, text: "x" });
    expect(r.status).toBe(400);
  });

  it("approves only the version the user saw, and only a valid one", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const f = `${base}/api/projects/${key}/features/demo`;
    const seen = (await json(await fetch(f))).sha256;
    expect(seen).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), FLOW.replace("Alpha", "Alpha 2"));
    expect((await post(`${f}/approve`, { sha256: seen })).status).toBe(409);
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), "version: 1\ntitle: [broken\n");
    const broken = (await json(await fetch(f))).sha256;
    expect((await post(`${f}/approve`, { sha256: broken })).status).toBe(409);
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), FLOW);
    expect((await post(`${f}/approve`, { sha256: seen })).status).toBe(200);
  });

  it("serves the flow.yaml JSON Schema", async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/schema/flow.v1.json`);
    expect(r.ok).toBe(true);
    expect((await r.json()).title).toContain("flow.yaml");
  });
});

describe("screen html", () => {
  it("inlines file: screens and rejects element anchors without a selector", async () => {
    const { base } = await boot();
    const dir = project();
    const fd = join(dir, ".design-flow", "demo");
    mkdirSync(join(fd, "screens"), { recursive: true });
    writeFileSync(join(fd, "screens", "a.html"), "<h1 class=hero>Alpha page</h1>");
    writeFileSync(join(fd, "flow.yaml"), FLOW.replace("{ id: A, title: Alpha }", "{ id: A, title: Alpha, file: screens/a.html }"));
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const f = `${base}/api/projects/${key}/features/demo`;
    const st = await json(await fetch(f));
    expect(st.flow.screens[0].html).toBe("<h1 class=hero>Alpha page</h1>");
    const bad = await post(`${f}/comments`, { anchor: { type: "element", screen: "A", point: { x: 1, y: 1 } }, text: "x" });
    expect(bad.status).toBe(400);
    const ok = await post(`${f}/comments`, {
      anchor: { type: "element", screen: "A", selector: "h1.hero", tag: "h1", text: "Alpha page", point: { x: 1, y: 1 } },
      text: "Bigger",
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).threads[0].where).toBe('Screen A Alpha · h1 "Alpha page" (h1.hero)');
  });

  it("reports a missing screen file as an issue", async () => {
    const { base } = await boot();
    const dir = project();
    writeFileSync(join(dir, ".design-flow", "demo", "flow.yaml"), FLOW.replace("{ id: A, title: Alpha }", "{ id: A, title: Alpha, file: screens/nope.html }"));
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const st = await json(await fetch(`${base}/api/projects/${key}/features/demo`));
    expect(st.issues.some((i: { message: string }) => i.message.includes("nope.html"))).toBe(true);
  });

  it("pushes an update when a screen file changes", async () => {
    const { base } = await boot();
    const dir = project();
    const fd = join(dir, ".design-flow", "demo");
    mkdirSync(join(fd, "screens"), { recursive: true });
    writeFileSync(join(fd, "screens", "a.html"), "<p>v1</p>");
    writeFileSync(join(fd, "flow.yaml"), FLOW.replace("{ id: A, title: Alpha }", "{ id: A, title: Alpha, file: screens/a.html }"));
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?project=${key}&feature=demo`);
    await nextMessage(ws, (m) => m.type === "state");
    const updated = nextMessage(ws, (m) => m.type === "state" && m.state.flow?.screens[0].html === "<p>v2</p>", 1500);
    writeFileSync(join(fd, "screens", "a.html"), "<p>v2</p>");
    await updated;
    ws.close();
  });

  it("fills screens from prototype.html, one section each, and sends the whole document for Play", async () => {
    const { base } = await boot();
    const dir = project();
    const fd = join(dir, ".design-flow", "demo");
    writeFileSync(
      join(fd, "prototype.html"),
      `<html><head><style>.x{color:red}</style></head><body><section data-screen="A"><button data-to="B">Go</button></section><section data-screen="B"><p>Beta page</p></section></body></html>`,
    );
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const st = await json(await fetch(`${base}/api/projects/${key}/features/demo`));
    expect(st.issues).toEqual([]);
    expect(st.flow.screens[1].html).toBe(`<section data-screen="B"><p>Beta page</p></section>`);
    expect(st.flow.style).toContain(".x{color:red}");
    expect(st.prototype).toContain(`<section data-screen="A">`);
  });

  it("lists prototype.html problems with the flow's issues", async () => {
    const { base } = await boot();
    const dir = project();
    writeFileSync(join(dir, ".design-flow", "demo", "prototype.html"), `<section data-screen="A"><a data-to="Q">x</a></section><section data-screen="B"></section>`);
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const st = await json(await fetch(`${base}/api/projects/${key}/features/demo`));
    expect(st.issues.map((i: { message: string }) => i.message)).toEqual(["data-to in A goes to unknown screen Q"]);
  });

  it("downloads the flow as one HTML file", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const res = await fetch(`${base}/api/projects/${key}/features/demo/share.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="demo.html"');
    expect(await res.text()).toContain("<title>Demo</title>");
  });

  it("publishes the HTML as a secret gist through gh and returns a link that opens it", async () => {
    const bin = mkdtempSync(join(tmpdir(), "df-gh-"));
    const log = join(bin, "calls.txt");
    // A stand-in gh: records its arguments and the file it was given, prints a gist URL.
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nfor a; do case "$a" in *.html) cp "$a" "${log}.html";; esac; done\necho https://gist.github.com/stv/abc123\n`,
      { mode: 0o755 },
    );
    const home = mkdtempSync(join(tmpdir(), "df-home-"));
    server = await startServer({ port: 0, home, gh: join(bin, "gh") });
    const base = `http://127.0.0.1:${server.port}`;
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const r = await json(await post(`${base}/api/projects/${key}/features/demo/share`, {}));
    expect(r).toEqual({ gist: "https://gist.github.com/stv/abc123", url: "https://gistcdn.githack.com/stv/abc123/raw/demo.html" });
    const args = readFileSync(log, "utf8").trim().split("\n");
    expect(args.slice(0, 2)).toEqual(["gist", "create"]);
    expect(args).not.toContain("--public");
    expect(readFileSync(`${log}.html`, "utf8")).toContain("<title>Demo</title>");
  });

  it("says what to do when gh is missing or not signed in", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-home-"));
    server = await startServer({ port: 0, home, gh: "/nonexistent/gh" });
    const base = `http://127.0.0.1:${server.port}`;
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const res = await post(`${base}/api/projects/${key}/features/demo/share`, {});
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/gh auth login/);
  });
});
