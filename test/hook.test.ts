import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CommentStore } from "../src/core/comments.ts";
import { startServer, type Server } from "../src/server/server.ts";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "bin", "design-flow.js");

let server: Server | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), "df-hook-"));
  mkdirSync(join(dir, ".design-flow", "pay"), { recursive: true });
  writeFileSync(join(dir, ".design-flow", "pay", "flow.yaml"), "version: 1\ntitle: Pay\nscreens: [{ id: A, title: Amount }]\n");
  return dir;
}

async function hook(dir: string, home: string) {
  const r = await run(process.execPath, [BIN, "hook"], {
    cwd: dir,
    env: { ...process.env, DESIGN_FLOW_HOME: home, DESIGN_FLOW_LOCALE: "en" },
  });
  return r.stdout;
}

/** Runs `hook --stop` with `input` on stdin: as JSON, or a string as it is. */
function stopHook(dir: string, home: string, input: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, "hook", "--stop"], { cwd: dir, env: { ...process.env, DESIGN_FLOW_HOME: home, DESIGN_FLOW_LOCALE: "en" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}`))));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

describe("design-flow hook --stop", () => {
  const stopping = { session_id: "s", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." };

  it("keeps the agent going while the user has unread messages, naming the count, features and command", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    const dir = project();
    mkdirSync(join(dir, ".design-flow", "intro"), { recursive: true });
    writeFileSync(join(dir, ".design-flow", "intro", "flow.yaml"), "version: 1\ntitle: Intro\nscreens: [{ id: A, title: A }]\n");
    const pay = CommentStore.load(join(dir, ".design-flow", "pay"));
    pay.addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "Secret wording one");
    pay.addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "Secret wording two");
    CommentStore.load(join(dir, ".design-flow", "intro")).addThread({ type: "canvas", point: { x: 0, y: 0 } }, "Secret wording three");
    const out = JSON.parse(await stopHook(dir, home, stopping));
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(out.hookSpecificOutput.hookEventName).toBe("Stop");
    const said = out.hookSpecificOutput.additionalContext;
    expect(said).toContain("3 unread messages");
    expect(said).toContain("1 on intro, 2 on pay");
    expect(said).toContain("design-flow comments intro, then design-flow comments pay");
    // It names no message, so nothing counts as read: the next prompt still delivers all three.
    expect(said).not.toContain("Secret wording");
    expect(JSON.parse(await stopHook(dir, home, stopping))).toEqual(out);
    const prompt = JSON.parse(await hook(dir, home)).hookSpecificOutput.additionalContext;
    for (const n of ["one", "two", "three"]) expect(prompt).toContain(`Secret wording ${n}`);
    expect(await stopHook(dir, home, stopping)).toBe("");
  });

  it("lets the agent stop once a stop hook already sent it on, and when nothing waits", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    const dir = project();
    const store = CommentStore.load(join(dir, ".design-flow", "pay"));
    store.addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "Unread");
    expect(await stopHook(dir, home, { ...stopping, stop_hook_active: true })).toBe("");
    store.markRead(store.threads.map((t) => t.id));
    // A question the agent asked waits on the user, not the agent.
    store.ask({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "Which one?", { options: ["One", "Two"], recommended: 0 });
    expect(await stopHook(dir, home, stopping)).toBe("");
    expect(await stopHook(mkdtempSync(join(tmpdir(), "df-empty-")), home, stopping)).toBe("");
  });

  it("works without input, as when run by hand", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    const dir = project();
    CommentStore.load(join(dir, ".design-flow", "pay")).addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "x");
    expect(JSON.parse(await stopHook(dir, home, "not json")).hookSpecificOutput.additionalContext).toContain("1 unread message ");
  });
});

describe("design-flow hook", () => {
  it("still delivers stored comments when the server is down", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    const dir = project();
    CommentStore.load(join(dir, ".design-flow", "pay")).addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "hi");
    expect(JSON.parse(await hook(dir, home)).hookSpecificOutput.additionalContext).toContain("hi");
    expect(await hook(dir, home)).toBe("");
  });

  it("injects unread comments as additional context, then counts them as read", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    server = await startServer({ port: 0, home });
    const dir = project();
    CommentStore.load(join(dir, ".design-flow", "pay")).addThread({ type: "screen", screen: "A", point: { x: 0, y: 0 } }, "Add a back button");
    const out = JSON.parse(await hook(dir, home));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("Screen A Amount");
    expect(out.hookSpecificOutput.additionalContext).toContain("Add a back button");
    expect(out.hookSpecificOutput.additionalContext).toContain("design-flow comments pay");
    expect(await hook(dir, home)).toBe("");
  });

  it("still injects a comment that was sent to a watcher, since sending is not reading", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    server = await startServer({ port: 0, home });
    const base = `http://127.0.0.1:${server.port}`;
    const dir = project();
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const { key } = await post("/api/projects", { dir });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events?project=${key}`);
    await new Promise((r) => ws.on("open", r));
    const pushed = new Promise((r) => ws.on("message", (d) => String(d).includes("Round the total") && r(true)));
    await post(`/api/projects/${key}/features/pay/comments`, { anchor: { type: "screen", screen: "A", point: { x: 0, y: 0 } }, text: "Round the total" });
    expect(await pushed).toBe(true);
    ws.close();
    expect(JSON.parse(await hook(dir, home)).hookSpecificOutput.additionalContext).toContain("Round the total");
    expect(await hook(dir, home)).toBe("");
  });

  it("prints nothing for a project without design-flow features", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    server = await startServer({ port: 0, home });
    expect(await hook(mkdtempSync(join(tmpdir(), "df-empty-")), home)).toBe("");
  });
});
