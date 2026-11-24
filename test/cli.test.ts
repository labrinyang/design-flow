import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const env = { ...process.env, DESIGN_FLOW_HOME: home, DESIGN_FLOW_PORT: "0", DESIGN_FLOW_LOCALE: "en" };

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
    expect((await df(["reply", "pay", id, "--text", "Added an error screen"], dir)).code).toBe(0);
    expect((await df(["resolve", "pay", id], dir)).code).toBe(0);
    const threads = JSON.parse(readFileSync(join(dir, ".design-flow", "pay", "comments.json"), "utf8")).threads;
    expect(threads[0].status).toBe("resolved");
    expect(threads[0].messages[1]).toMatchObject({ author: "agent", text: "Added an error screen" });
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
    for (let i = 0; i < 30 && !out.includes("Show the receipt"); i++) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    const lines = out.trim().split("\n").filter((l) => l.includes("Show the receipt"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[design-flow] pay");
    expect(lines[0]).toContain("Screen B Done");
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
