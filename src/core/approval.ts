import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommentStore } from "./comments.ts";

export type Status = "draft" | "approved" | "stale";
export interface Approval {
  sha256: string;
  at: string;
  /** The agent was shown this approval, by `status` or the prompt hook. */
  seen?: boolean;
  /** Written by versions before `seen`. */
  delivered?: boolean;
}

export const hashFlow = (text: string, prototype?: string) => {
  const h = createHash("sha256").update(text);
  if (prototype !== undefined) h.update("\0prototype.html\0").update(prototype);
  return h.digest("hex");
};

/** The hash of what the user reviews: flow.yaml, and prototype.html when the screens live there. */
export function hashSpec(dir: string): string {
  const proto = join(dir, "prototype.html");
  return hashFlow(readFileSync(join(dir, "flow.yaml"), "utf8"), existsSync(proto) ? readFileSync(proto, "utf8") : undefined);
}
const approvalFile = (dir: string) => join(dir, "approval.json");

function read(dir: string): Approval | undefined {
  const f = approvalFile(dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Approval) : undefined;
}

export function approve(dir: string): Approval {
  const a: Approval = { sha256: hashSpec(dir), at: new Date().toISOString() };
  writeFileSync(approvalFile(dir), JSON.stringify(a, null, 2) + "\n");
  return a;
}

export function approvalStatus(dir: string): { status: Status; openThreads: number; approvedAt?: string } {
  const a = read(dir);
  const openThreads = CommentStore.load(dir).threads.filter((t) => t.status === "open").length;
  if (!a) return { status: "draft", openThreads };
  const status = existsSync(join(dir, "flow.yaml")) && a.sha256 === hashSpec(dir) ? "approved" : "stale";
  return { status, openThreads, approvedAt: a.at };
}

/**
 * The approval the agent has not been shown, while it still covers the spec as it is. An older file's
 * `delivered` counts as shown: unlike a comment, an approval loses nothing when its notice is missed,
 * because `status` always reports it.
 */
export function unseenApproval(dir: string): Approval | undefined {
  const a = read(dir);
  if (!a || (a.seen ?? a.delivered) || !existsSync(join(dir, "flow.yaml")) || a.sha256 !== hashSpec(dir)) return undefined;
  return a;
}

/** Record that the agent was shown approval `a`. A newer approval stays unseen. */
export function markApprovalSeen(dir: string, a: Approval) {
  const cur = read(dir);
  if (!cur || cur.at !== a.at || cur.sha256 !== a.sha256) return;
  const { delivered: _old, ...rest } = cur;
  writeFileSync(approvalFile(dir), JSON.stringify({ ...rest, seen: true }, null, 2) + "\n");
}
