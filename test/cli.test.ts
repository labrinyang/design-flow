import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "bin", "design-flow.js");
// What the installed skill runs: the bundled launcher, a different build id from the dev build in dist/.
const SKILL_BIN = join(import.meta.dirname, "..", "skills", "design-flow", "scripts", "design-flow.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bundledBuild = () => createHash("sha1").update(readFileSync(SKILL_BIN)).digest("hex").slice(0, 12);
const serverInfo = (): { pid: number; port: number; build?: string } | undefined => {
  try {
    return JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
  } catch {
    return undefined;
  }
};
const healthy = (info?: { port: number }) =>
  info ? fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false) : Promise.resolve(false);
async function until<T>(what: string, f: () => T | undefined | Promise<T | undefined>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
/** The running server's entry for `dir` once it is registered (registrations persist across servers in one home). */
async function registeredOn(dir: string) {
  const info = serverInfo();
  if (!info) return undefined;
  const list = await fetch(`http://127.0.0.1:${info.port}/api/projects`).then((r) => r.json() as Promise<{ dir: string; key: string }[]>, () => undefined);
  return list?.find((p) => p.dir.endsWith(dir.split("/").pop()!));
}
const bundledUp = () =>
  until("the bundled build to serve", async () => {
    const i = serverInfo();
    return i && i.build === bundledBuild() && (await healthy(i)) ? i : undefined;
  });
const home = mkdtempSync(join(tmpdir(), "df-cli-home-"));
// No CLAUDE_CODE_SESSION_ID from a Claude Code session running the tests: each test that wants one sets its own.
const env = { ...process.env, DESIGN_FLOW_HOME: home, DESIGN_FLOW_PORT: "0", DESIGN_FLOW_LOCALE: "en", CLAUDE_CODE_SESSION_ID: "" };

async function df(args: string[], cwd: string) {
  try {
    const r = await run(process.execPath, [BIN, ...args], { cwd, env });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

function project(flow?: string) {
  const dir = mkdtempSync(join(tmpdir(), "df-cli-proj-"));
  if (flow) {
    mkdirSync(join(dir, ".design-flow", "pay"), { recursive: true });
    writeFileSync(join(dir, ".design-flow", "pay", "flow.yaml"), flow);
  }
  return dir;
}

const FLOW = `version: 1
title: Pay
screens:
  - { id: A, title: Amount }
  - { id: B, title: Done }
edges:
  - { from: A, to: B, label: Pay }
`;

beforeAll(() => {
  if (!existsSync(BIN) || !existsSync(SKILL_BIN)) throw new Error("run pnpm build first");
});
afterAll(async () => {
  await df(["stop"], tmpdir());
});

describe("design-flow CLI", () => {
  it("check exits 0 for a clean flow and 3 with located issues", async () => {
    const dir = project(FLOW);
    expect((await df(["check", "pay"], dir)).code).toBe(0);
    writeFileSync(join(dir, ".design-flow", "pay", "flow.yaml"), FLOW.replace("to: B", "to: Z"));
    const bad = await df(["check", "pay"], dir);
    expect(bad.code).toBe(3);
    expect(bad.out).toMatch(/flow\.yaml:7:\d+ .*"Z"/);
  });

  it("check also validates prototype.html against flow.yaml", async () => {
    const dir = project(FLOW);
    writeFileSync(join(dir, ".design-flow", "pay", "prototype.html"), `<section data-screen="A">\n<button data-to="C">Pay</button></section><section data-screen="B"></section>`);
    const bad = await df(["check", "pay"], dir);
    expect(bad.code).toBe(3);
    expect(bad.out).toMatch(/prototype\.html:2:1 data-to in A goes to unknown screen C/);
  });

  it("open replaces a running server from an older build instead of reusing it", async () => {
    const dir = project(FLOW);
    // A stand-in for a server left running from before an update: answers /health without this build's id.
    const old = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>r.end(JSON.stringify({ok:true,app:"design-flow",version:"0.1.0"}))).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`], { stdio: ["ignore", "pipe", "ignore"] });
    const port = Number(await new Promise<string>((r) => old.stdout!.once("data", (d) => r(String(d).trim()))));
    writeFileSync(join(home, "server.json"), JSON.stringify({ pid: old.pid, port, version: "0.1.0" }));
    const exited = new Promise((r) => old.once("exit", r));
    const r = await df(["open", "pay", "--no-open"], dir);
    expect(r.code, r.err).toBe(0);
    await exited;
    const info = JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
    expect(info.pid).not.toBe(old.pid);
    expect(r.out).not.toContain(`:${port}/`);
  });

  it("open writes a template, starts the server and prints the URL", async () => {
    const dir = project();
    const r = await df(["open", "signup", "--no-open"], dir);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, ".design-flow", "signup", "flow.yaml"))).toBe(true);
    expect(readFileSync(join(dir, ".design-flow", "signup", "prototype.html"), "utf8")).toContain('data-screen="M01"');
    const url = r.out.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
    expect(url).toBeTruthy();
    const health = await fetch(new URL("/health", url!));
    expect(health.ok).toBe(true);
    expect((await df(["check", "signup"], dir)).code).toBe(0);
  });

  it("comments, reply and resolve go through the same threads", async () => {
    const dir = project(FLOW);
    const opened = await df(["open", "pay", "--no-open"], dir);
    const base = new URL(opened.out.match(/http:\/\/\S+/)![0]).origin;
    const key = (await (await fetch(`${base}/api/projects`)).json()).find((p: { dir: string }) => p.dir.endsWith(dir.split("/").pop()!)).key;
    await fetch(`${base}/api/projects/${key}/features/pay/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: { type: "edge", edge: { from: "A", to: "B" }, point: { x: 0, y: 0 } }, text: "What if it fails?" }),
    });
    const list = await df(["comments", "pay", "--unread"], dir);
    expect(list.out).toContain('Edge A → B "Pay"');
    expect(list.out).toContain("What if it fails?");
    const id = list.out.match(/#(\w{8})/)![1];
    expect((await df(["comments", "pay", "--unread"], dir)).out).not.toContain("What if it fails?");
    const file = join(dir, ".design-flow", "pay", "comments.json");
    // Options need two to four labels and a recommendation (or the one applied); a bad reply stores nothing.
    for (const bad of [
      ["--option", "only one", "--recommend", "A"],
      ["--option", "a", "--option", "b"],
      ["--option", "a", "--option", "b", "--recommend", "C"],
      ["--recommend", "A"],
    ])
      expect((await df(["reply", "pay", id, "--text", "x", ...bad], dir)).code, bad.join(" ")).toBe(2);
    const replied = await df(
      ["reply", "pay", id, "--text", "Two ways to show it", "--option", "An error screen", "--option=An inline error", "--applied", "1"],
      dir,
    );
    expect(replied).toMatchObject({ code: 0, out: `Replied to #${id}.\n` });
    const offer = JSON.parse(readFileSync(file, "utf8")).threads[0].messages[1];
    expect(offer).toMatchObject({ author: "agent", text: "Two ways to show it", options: ["An error screen", "An inline error"], applied: 0 });
    expect((await df(["comments", "pay"], dir)).out).toContain("    A. An error screen (applied)\n    B. An inline error\n");
    // The user picks B on the canvas. Resolving waits until the agent has read that.
    await fetch(`${base}/api/projects/${key}/features/pay/threads/${id}/pick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: offer.id, option: 1 }),
    });
    const blocked = await df(["resolve", "pay", id], dir);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain("picked B: An inline error");
    expect((await df(["resolve", "pay", id], dir)).code).toBe(0);
    const threads = JSON.parse(readFileSync(file, "utf8")).threads;
    expect(threads[0].status).toBe("resolved");
    expect(threads[0].messages.map((m: { author: string }) => m.author)).toEqual(["user", "agent", "user"]);
  });

  it("a comment the watcher printed stays unread until comments shows it to the agent", async () => {
    const dir = project(FLOW);
    const base = new URL((await df(["open", "pay", "--no-open"], dir)).out.match(/http:\/\/\S+/)![0]).origin;
    const child = spawn(process.execPath, [BIN, "watch"], { cwd: dir, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    try {
      const p = await until("watch to register", () => registeredOn(dir));
      await fetch(`${base}/api/projects/${p.key}/features/pay/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: { type: "screen", screen: "B", point: { x: 0, y: 0 } }, text: "Show the fee" }),
      });
      await until("the watch line", () => out.includes("Show the fee") || undefined);
      expect((await df(["status", "pay"], dir)).out).toContain("1 open thread (1 unread)");
      expect((await df(["comments", "pay", "--unread"], dir)).out).toContain("Show the fee");
      expect((await df(["comments", "pay", "--unread"], dir)).out).toBe("No unread comments.\n");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reply shows the agent what the user wrote that it had not read", async () => {
    const dir = project(FLOW);
    const base = new URL((await df(["open", "pay", "--no-open"], dir)).out.match(/http:\/\/\S+/)![0]).origin;
    const p = (await registeredOn(dir))!;
    const api = (path: string, body: unknown) =>
      fetch(`${base}/api/projects/${p.key}/features/pay${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await api("/comments", { anchor: { type: "screen", screen: "A", point: { x: 0, y: 0 } }, text: "First note" });
    const id = (await df(["comments", "pay", "--unread"], dir)).out.match(/#(\w{8})/)![1];
    await api(`/threads/${id}/reply`, { text: "One more thing" });
    const r = await df(["reply", "pay", id, "--text", "Done"], dir);
    expect(r.out).toContain("Before your reply the user also wrote, unread until now:\n  user: One more thing");
    expect((await df(["comments", "pay", "--unread"], dir)).out).toBe("No unread comments.\n");
  });

  it("status reports draft, approved and stale", async () => {
    const dir = project(FLOW);
    expect((await df(["status", "pay"], dir)).out).toMatch(/^draft/);
    writeFileSync(join(dir, ".design-flow", "pay", "approval.json"), "{}");
    const { approve } = await import("../src/core/approval.ts");
    approve(join(dir, ".design-flow", "pay"));
    expect((await df(["status", "pay"], dir)).out).toMatch(/^approved/);
    writeFileSync(join(dir, ".design-flow", "pay", "flow.yaml"), FLOW + "\n# edit\n");
    expect((await df(["status", "pay"], dir)).out).toMatch(/^stale/);
  });

  it("watch prints one line per new comment", async () => {
    const dir = project(FLOW);
    const opened = await df(["open", "pay", "--no-open"], dir);
    const base = new URL(opened.out.match(/http:\/\/\S+/)![0]).origin;
    const child = spawn(process.execPath, [BIN, "watch"], { cwd: dir, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 700));
    const key = (await (await fetch(`${base}/api/projects`)).json()).find((p: { dir: string }) => p.dir.endsWith(dir.split("/").pop()!)).key;
    await fetch(`${base}/api/projects/${key}/features/pay/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: { type: "screen", screen: "B", point: { x: 0, y: 0 } }, text: "Show the receipt" }),
    });
    // Comments print in batches, 2 s after the first.
    for (let i = 0; i < 60 && !out.includes("Show the receipt"); i++) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    const lines = out.trim().split("\n").filter((l) => l.includes("Show the receipt"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[design-flow] pay");
    expect(lines[0]).toContain("Screen B Done");
  });

  it("watch prints comments that come close together as one batch, and an approval at once", async () => {
    const dir = project(FLOW);
    const base = new URL((await df(["open", "pay", "--no-open"], dir)).out.match(/http:\/\/\S+/)![0]).origin;
    const child = spawn(process.execPath, [BIN, "watch"], { cwd: dir, env });
    const chunks: { at: number; text: string }[] = [];
    child.stdout.on("data", (d) => chunks.push({ at: Date.now(), text: String(d) }));
    const out = () => chunks.map((c) => c.text).join("");
    try {
      const p = await until("watch to register", () => registeredOn(dir));
      const f = `${base}/api/projects/${p.key}/features/pay`;
      const post = (path: string, body: unknown) => fetch(f + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const first = Date.now();
      await post("/comments", { anchor: { type: "screen", screen: "A", point: { x: 0, y: 0 } }, text: "First note" });
      await sleep(600);
      await post("/comments", { anchor: { type: "screen", screen: "B", point: { x: 0, y: 0 } }, text: "Second note" });
      await until("the batch", () => (out().includes("Second note") ? true : undefined));
      const batch = chunks.find((c) => c.text.includes("First note"))!;
      expect(batch.text).toContain("Second note");
      expect(batch.at - first).toBeGreaterThanOrEqual(1900);
      expect(batch.text.trim().split("\n")).toHaveLength(2);
      const { sha256 } = await (await fetch(f)).json();
      const asked = Date.now();
      await post("/approve", { sha256 });
      await until("the approval", () => (out().includes("APPROVED") ? true : undefined));
      expect(chunks.find((c) => c.text.includes("APPROVED"))!.at - asked).toBeLessThan(1500);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("ask starts a thread as the agent, and the user's answer arrives like any reply", async () => {
    const dir = project(FLOW);
    const base = new URL((await df(["open", "pay", "--no-open"], dir)).out.match(/http:\/\/\S+/)![0]).origin;
    for (const bad of [
      ["ask", "pay", "B"],
      ["ask", "pay", "--text", "Which?"],
      ["ask", "pay", "Z", "--text", "Which?"],
      ["ask", "pay", "B", "--text", "Which?", "--option", "Only one", "--recommend", "A"],
      ["ask", "pay", "B", "--text", "Which?", "--option", "Yes", "--option", "No"],
    ])
      expect((await df(bad, dir)).code, bad.join(" ")).toBe(2);
    const asked = await df(["ask", "pay", "B", "--text", "Show a receipt here?", "--option", "Yes", "--option", "No", "--recommend", "A"], dir);
    expect(asked.code, asked.err).toBe(0);
    const id = asked.out.match(/^Asked #(\w{8}) on Screen B Done\.\n$/)![1];
    const file = join(dir, ".design-flow", "pay", "comments.json");
    const t = JSON.parse(readFileSync(file, "utf8")).threads[0];
    expect(t).toMatchObject({ id, seen: 1, status: "open", anchor: { type: "screen", screen: "B" }, messages: [{ author: "agent", options: ["Yes", "No"], recommended: 0 }] });
    expect(Number.isFinite(t.anchor.point.x) && Number.isFinite(t.anchor.point.y)).toBe(true);
    expect((await df(["status", "pay"], dir)).out).toBe("draft · 1 open thread\n");
    expect((await df(["comments", "pay", "--unread"], dir)).out).toBe("No unread comments.\n");
    const child = spawn(process.execPath, [BIN, "watch"], { cwd: dir, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    try {
      const p = await until("watch to register", () => registeredOn(dir));
      await fetch(`${base}/api/projects/${p.key}/features/pay/threads/${id}/pick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: t.messages[0].id, option: 0 }),
      });
      await until("the watch line", () => out.includes("picked A: Yes") || undefined);
      expect(out).toContain(`reply #${id} on Screen B Done: picked A: Yes`);
    } finally {
      child.kill("SIGKILL");
    }
    expect((await df(["status", "pay"], dir)).out).toBe("draft · 1 open thread (1 unread)\n");
    expect((await df(["comments", "pay", "--unread"], dir)).out).toBe(
      `#${id} [open] Screen B Done\n  agent: Show a receipt here?\n    A. Yes (recommended)\n    B. No\n  user  (new): picked A: Yes\n`,
    );
    expect((await df(["comments", "pay", "--unread"], dir)).out).toBe("No unread comments.\n");
  });

  it("outline lists the flow without rendering, with each screen's open and unread threads, and marks nothing read", async () => {
    const dir = project(FLOW);
    const { CommentStore } = await import("../src/core/comments.ts");
    const store = CommentStore.load(join(dir, ".design-flow", "pay"));
    store.addThread({ type: "element", screen: "A", selector: "h1", tag: "h1", text: "Pay", point: { x: 0, y: 0 } }, "Bigger");
    store.ask({ type: "screen", screen: "B", point: { x: 0, y: 0 } }, "Receipt?");
    store.addThread({ type: "edge", edge: { from: "A", to: "B" }, point: { x: 0, y: 0 } }, "What if it fails?");
    const r = await df(["outline", "pay"], dir);
    expect(r).toMatchObject({
      code: 0,
      out: [
        "Pay",
        "viewport 390x844",
        "screens",
        "  A  Amount  (no lane)  390x844  1 open, 1 unread",
        "  B  Done    (no lane)  390x844  1 open",
        "edges",
        "  A → B  Pay",
        "threads on edges, lanes or the canvas: 1 open, 1 unread",
        "",
      ].join("\n"),
    });
    const json = JSON.parse((await df(["outline", "pay", "--json"], dir)).out);
    expect(json.screens[0]).toEqual({ id: "A", title: "Amount", lane: null, viewport: { width: 390, height: 844 }, open: 1, unread: 1 });
    expect(json.edges).toEqual([{ from: "A", to: "B", label: "Pay" }]);
    expect(CommentStore.load(join(dir, ".design-flow", "pay")).unread()).toHaveLength(2);
  });

  it("comments names the prototype.html line of an element anchor that has one", async () => {
    const dir = project(FLOW);
    const { CommentStore } = await import("../src/core/comments.ts");
    const anchor = { type: "element" as const, screen: "A", selector: '[data-id="pay"]', tag: "button", text: "Pay", point: { x: 0, y: 0 } };
    CommentStore.load(join(dir, ".design-flow", "pay")).addThread({ ...anchor, line: 12 }, "Bigger");
    CommentStore.load(join(dir, ".design-flow", "pay")).addThread(anchor, "Rounder");
    const out = (await df(["comments", "pay"], dir)).out;
    expect(out).toContain('[open] Screen A Amount · button "Pay" ([data-id="pay"]) prototype.html:12\n  user  (new): Bigger');
    expect(out).toContain('[open] Screen A Amount · button "Pay" ([data-id="pay"])\n  user  (new): Rounder');
    expect(JSON.parse((await df(["comments", "pay", "--json"], dir)).out)[0].anchor.line).toBe(12);
  });

  // On Windows kill() ends a process outright, so there is no handler to test.
  it.skipIf(process.platform === "win32")("watch exits on SIGTERM and SIGINT, from the dev entry and the bundled skill", async () => {
    expect((await df(["open", "pay", "--no-open"], project(FLOW))).code).toBe(0);
    for (const [bin, signal] of [
      [BIN, "SIGTERM"],
      [BIN, "SIGINT"],
      [SKILL_BIN, "SIGTERM"],
      [SKILL_BIN, "SIGINT"],
    ] as const) {
      const dir = project(FLOW);
      const child = spawn(process.execPath, [bin, "watch"], { cwd: dir, env, stdio: "ignore" });
      const exited = new Promise((r) => child.once("exit", (code, sig) => r(code ?? sig)));
      try {
        // watch registers its directory only once its signal handlers are in place.
        await until(`${bin} to register`, () => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${bin} exited before registering`);
          return registeredOn(dir);
        });
        child.kill(signal);
        expect(await Promise.race([exited, sleep(3000).then(() => "still running")]), `${bin} on ${signal}`).toBe(0);
      } finally {
        child.kill("SIGKILL");
      }
    }
  }, 30000);

  it("watch follows a canvas in another folder once a command of its session uses it, and a second watch of the session ends", async () => {
    const own = project();
    const other = project(FLOW);
    const base = new URL((await df(["open", "pay", "--no-open"], other)).out.match(/http:\/\/\S+/)![0]).origin;
    const session = `watch-${process.pid}-${Date.now()}`;
    const senv = { ...env, CLAUDE_CODE_SESSION_ID: session };
    const child = spawn(process.execPath, [BIN, "watch"], { cwd: own, env: senv });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    try {
      await until("the watch to claim its session", () => existsSync(join(home, "watch", `${session}.pid`)) || undefined);
      const second = await run(process.execPath, [BIN, "watch"], { cwd: own, env: senv, timeout: 10000 });
      expect(second.stderr).toContain("this session already has a watch running");
      await run(process.execPath, [BIN, "status", "pay", "--project-dir", other], { cwd: own, env: senv });
      const p = await until("the other folder's project", () => registeredOn(other));
      await fetch(`${base}/api/projects/${p.key}/features/pay/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: { type: "screen", screen: "A", point: { x: 0, y: 0 } }, text: "Follow the other folder" }),
      });
      await until("the watch line", () => out.includes("Follow the other folder") || undefined);
      expect(out).toContain(`design-flow comments pay --shots --project-dir ${realpathSync(other)}`);
      // The session's own folder holds no canvas, so the watch did not register it, which would have created one.
      expect(existsSync(join(own, ".design-flow"))).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("a fresh watch replaces a server of another build, as open does", async () => {
    const dir = project(FLOW);
    expect((await df(["open", "pay", "--no-open"], dir)).code).toBe(0);
    const dev = serverInfo()!;
    expect(dev.build).not.toBe(bundledBuild());
    const child = spawn(process.execPath, [SKILL_BIN, "watch"], { cwd: dir, env, stdio: "ignore" });
    try {
      expect((await bundledUp()).pid).not.toBe(dev.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a reconnecting watch attaches to whatever server is up and does not restart a stopped one", async () => {
    const dir = project(FLOW);
    const other = project(FLOW);
    expect((await df(["open", "pay", "--no-open"], other)).code).toBe(0);
    const child = spawn(process.execPath, [SKILL_BIN, "watch"], { cwd: dir, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    try {
      // Its first connect puts its own build up; then the dev CLI's open brings a dev server back.
      await bundledUp();
      expect((await df(["open", "pay", "--no-open"], other)).code).toBe(0);
      const dev = serverInfo()!;
      expect(dev.build).not.toBe(bundledBuild());
      // The watcher comes back to the dev server instead of replacing it: a comment posted there reaches it.
      const p = await until("the watcher's project on the dev server", () => registeredOn(dir));
      await fetch(`http://127.0.0.1:${dev.port}/api/projects/${p.key}/features/pay/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: { type: "screen", screen: "A", point: { x: 0, y: 0 } }, text: "Round the amount" }),
      });
      await until("the comment line", () => out.includes("Round the amount") || undefined);
      expect(serverInfo()!.pid).toBe(dev.pid);
      // After stop it waits instead of starting a server of its own, and says so once.
      const errBefore = err.length;
      expect((await df(["stop"], other)).out).toContain("Stopped.");
      await sleep(3500);
      expect(serverInfo()!.pid).toBe(dev.pid);
      expect(await healthy(dev)).toBe(false);
      expect(err.slice(errBefore).match(/no server running/g)).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);
});

describe("template schema header", () => {
  it("points editors at a schema the server actually serves", async () => {
    const dir = project();
    const r = await df(["open", "schema-check", "--no-open"], dir);
    const head = readFileSync(join(dir, ".design-flow", "schema-check", "flow.yaml"), "utf8").split("\n")[0];
    const url = head.match(/\$schema=(\S+)/)![1];
    const res = await fetch(url);
    expect(res.ok, `${url} from ${r.out}`).toBe(true);
    expect((await res.json()).title).toContain("flow.yaml");
  });
});
