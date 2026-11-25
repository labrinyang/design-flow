import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/*
 * Which canvas folders a Claude Code session works on. The plugin's hooks and its watch monitor start in the folder
 * the session was opened in, but an agent often reaches a canvas in another folder with --project-dir. Each command it
 * runs records that folder against its session (Claude Code gives every command and monitor the session's id in
 * CLAUDE_CODE_SESSION_ID, and every hook as session_id), so that session's hooks and monitor look there too, and no
 * other session's do.
 */

export const homeDir = () => process.env.DESIGN_FLOW_HOME ?? join(homedir(), ".design-flow");

interface Link {
  session: string;
  project: string;
  at: string;
}

/** Links older than this are dropped when the next one is written. */
const KEEP_MS = 14 * 24 * 3600_000;
const linksFile = (home: string) => join(home, "sessions.json");

/** A session id as Claude Code gives it, or undefined. */
export const sessionId = (v: unknown): string | undefined => (typeof v === "string" && /^[\w-]{1,128}$/.test(v) ? v : undefined);

export function canonical(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

function readLinks(home: string): Link[] {
  try {
    const v: unknown = JSON.parse(readFileSync(linksFile(home), "utf8"));
    if (!Array.isArray(v)) return [];
    return v.filter((l): l is Link => !!l && typeof l.session === "string" && typeof l.project === "string" && typeof l.at === "string");
  } catch {
    return [];
  }
}

/** Records that `session` works on the canvases in `project`. */
export function linkSession(home: string, session: string | undefined, project: string, now = Date.now()): void {
  if (!session) return;
  const dir = canonical(project);
  const links = readLinks(home).filter((l) => now - Date.parse(l.at) < KEEP_MS && !(l.session === session && l.project === dir));
  links.push({ session, project: dir, at: new Date(now).toISOString() });
  mkdirSync(home, { recursive: true });
  // Written whole, then renamed: a hook reading at the same moment never sees half a file.
  const tmp = `${linksFile(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(links, null, 2) + "\n");
  renameSync(tmp, linksFile(home));
}

/** The folders `session` has run commands on that still hold canvases. */
export function linkedProjects(home: string, session: string | undefined): string[] {
  if (!session) return [];
  const dirs = new Set(readLinks(home).filter((l) => l.session === session).map((l) => l.project));
  return [...dirs].filter((d) => existsSync(join(d, ".design-flow")));
}

/** Where a session's hooks look: the folder it was opened in, then the other folders it has worked on. */
export function sessionProjects(home: string, own: string, session: string | undefined): { dir: string; own: boolean }[] {
  const mine = canonical(own);
  return [{ dir: own, own: true }, ...linkedProjects(home, session).filter((d) => d !== mine).map((dir) => ({ dir, own: false }))];
}

/** A path as one shell word, for the commands a hook or watch tells the agent to run. */
export const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** How often a watch marks its claim as alive; a claim not marked for three times this is stale. */
const BEAT_MS = 30_000;

/**
 * One watch per session: the plugin's monitor and a Monitor the agent starts from the skill would otherwise print
 * every line twice. Returns a release function, undefined without a session, or false when a live watch of the same
 * session holds it.
 */
export function claimWatch(home: string, session: string | undefined): (() => void) | undefined | false {
  if (!session) return undefined;
  const dir = join(home, "watch");
  const file = join(dir, `${session}.pid`);
  mkdirSync(dir, { recursive: true });
  try {
    const pid = Number(readFileSync(file, "utf8"));
    const fresh = Date.now() - statSync(file).mtimeMs < 3 * BEAT_MS;
    if (pid && pid !== process.pid && fresh && alive(pid)) return false;
  } catch {
    /* no claim yet */
  }
  writeFileSync(file, String(process.pid));
  const beat = setInterval(() => {
    try {
      utimesSync(file, new Date(), new Date());
    } catch {
      /* removed: the next watch claims it */
    }
  }, BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      if (Number(readFileSync(file, "utf8")) === process.pid) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
