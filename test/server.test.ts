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

  it("delivers a new comment to the events socket exactly once", async () => {
    const { base } = await boot();
    const dir = project();
    const { key } = await json(await post(`${base}/api/projects`, { dir }));
    const ws = new WebSocket(`${base.replace("http", "ws")}/events?project=${key}`);
    await new Promise((r) => ws.on("open", r));
    const got = nextMessage(ws, (m) => m.type === "comment");
    await json(
      await post(`${base}/api/projects/${key}/features/demo/comments`, {
        anchor: { type: "screen", screen: "A", point: { x: 1, y: 2 } },
        text: "Needs a back button",
      }),
    );
    const m = await got;
    expect(m).toMatchObject({ feature: "demo", text: "Needs a back button", where: "Screen A Alpha" });
    const ws2 = new WebSocket(`${base.replace("http", "ws")}/events?project=${key}`);
    const extra = nextMessage(ws2, (x) => x.type === "comment", 600).catch(() => "none");
    expect(await extra).toBe("none");
    ws.close();
    ws2.close();
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
});
