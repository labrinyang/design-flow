import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "bin", "design-flow.js");
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
  if (!existsSync(BIN)) throw new Error("run pnpm build first");
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

  it("open writes a template, starts the server and prints the URL", async () => {
    const dir = project();
    const r = await df(["open", "signup", "--no-open"], dir);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, ".design-flow", "signup", "flow.yaml"))).toBe(true);
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
