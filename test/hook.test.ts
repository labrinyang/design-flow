import { execFile } from "node:child_process";
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
