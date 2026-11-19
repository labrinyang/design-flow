import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SKILL = join(import.meta.dirname, "..", "skills", "design-flow");

describe("packaged skill", () => {
  it("has SKILL.md with name and description frontmatter", () => {
    const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(md).toMatch(/^---\nname: design-flow\ndescription: .+\n---/);
    expect(md).toContain("scripts/design-flow.mjs");
  });

  it("runs from a copy of the skill folder alone: open, serve the canvas, check", async () => {
    const copy = mkdtempSync(join(tmpdir(), "df-skill-"));
    cpSync(SKILL, copy, { recursive: true });
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
    const project = mkdtempSync(join(tmpdir(), "df-skill-proj-"));
    const home = mkdtempSync(join(tmpdir(), "df-skill-home-"));
    const env = { ...process.env, DESIGN_FLOW_HOME: home, DESIGN_FLOW_PORT: "0", NODE_PATH: "" };
    const bin = join(copy, "scripts", "design-flow.mjs");
    try {
      const r = await run(process.execPath, [bin, "open", "signup", "--no-open"], { cwd: project, env });
      const url = r.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\S+/)![0];
      const page = await fetch(url);
      expect(await page.text()).toContain('<div id="root">');
      const js = (await (await fetch(url)).text()).match(/src="(\/assets\/[^"]+\.js)"/)![1];
      expect((await fetch(new URL(js, url))).ok).toBe(true);
      const c = await run(process.execPath, [bin, "check", "signup"], { cwd: project, env });
      expect(c.stdout).toContain("signup: clean");
    } finally {
      await run(process.execPath, [bin, "stop"], { cwd: project, env }).catch(() => {});
    }
  });
});
