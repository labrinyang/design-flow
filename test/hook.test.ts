import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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

  it("injects undelivered comments as additional context, once", async () => {
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

  it("prints nothing for a project without design-flow features", async () => {
    const home = mkdtempSync(join(tmpdir(), "df-hook-home-"));
    server = await startServer({ port: 0, home });
    expect(await hook(mkdtempSync(join(tmpdir(), "df-empty-")), home)).toBe("");
  });
});
