import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, claimWatch, linkedProjects, linkSession, sessionId, sessionProjects, shellWord } from "../src/cli/sessions.ts";

/** A folder with a .design-flow directory, by its real path. */
function canvas() {
  const dir = mkdtempSync(join(tmpdir(), "df-sess-"));
  mkdirSync(join(dir, ".design-flow"));
  return canonical(dir);
}

describe("session links", () => {
  it("tie each folder to the sessions that ran commands there, once, and drop links older than two weeks", () => {
    const home = mkdtempSync(join(tmpdir(), "df-sess-home-"));
    const [a, b] = [canvas(), canvas()];
    const plain = mkdtempSync(join(tmpdir(), "df-sess-"));
    const now = Date.now();
    linkSession(home, "s1", a, now - 15 * 24 * 3600_000);
    linkSession(home, "s1", b, now);
    linkSession(home, "s1", b, now);
    linkSession(home, "s2", a, now);
    linkSession(home, "s1", plain, now);
    linkSession(home, undefined, a, now);
    expect(linkedProjects(home, "s1")).toEqual([b]);
    expect(linkedProjects(home, "s2")).toEqual([a]);
    expect(linkedProjects(home, undefined)).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"))).toHaveLength(3);
  });

  it("put the session's own folder first, and only once", () => {
    const home = mkdtempSync(join(tmpdir(), "df-sess-home-"));
    const [own, other] = [canvas(), canvas()];
    linkSession(home, "s", own);
    linkSession(home, "s", other);
    expect(sessionProjects(home, own, "s")).toEqual([
      { dir: own, own: true },
      { dir: other, own: false },
    ]);
  });

  it("take only ids shaped like Claude Code's, and quote a path for the shell when it needs quoting", () => {
    expect(sessionId("6bdeb710-2f5f-4deb-8125-e9602a09715f")).toBe("6bdeb710-2f5f-4deb-8125-e9602a09715f");
    expect(sessionId("")).toBeUndefined();
    expect(sessionId("../x")).toBeUndefined();
    expect(shellWord("/Users/me/app-monorepo")).toBe("/Users/me/app-monorepo");
    expect(shellWord("/Users/me/My Project")).toBe("'/Users/me/My Project'");
    expect(shellWord("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });
});

describe("claimWatch", () => {
  it("lets one live watch hold a session, and takes over a claim whose watch has exited or gone quiet", () => {
    const home = mkdtempSync(join(tmpdir(), "df-sess-home-"));
    const file = join(home, "watch", "s.pid");
    expect(claimWatch(home, undefined)).toBeUndefined();
    const release = claimWatch(home, "s");
    if (typeof release !== "function") throw new Error("not claimed");
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(file)).toBe(false);
    // Another live process holds it.
    writeFileSync(file, String(process.ppid));
    expect(claimWatch(home, "s")).toBe(false);
    // Not once its claim has gone unmarked for minutes.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, old, old);
    const quiet = claimWatch(home, "s");
    if (typeof quiet !== "function") throw new Error("a quiet claim was not taken over");
    quiet();
    // A process id above any system's limit belongs to no process.
    writeFileSync(file, String(2 ** 22 + 1));
    const exited = claimWatch(home, "s");
    if (typeof exited !== "function") throw new Error("an exited watch's claim was not taken over");
    exited();
  });
});
