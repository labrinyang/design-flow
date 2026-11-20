import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommentStore } from "./comments.ts";

export type Status = "draft" | "approved" | "stale";
interface Approval {
  sha256: string;
  at: string;
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

/** The approval the agent has not been told about yet, marked delivered. */
export function takeApprovalEvent(dir: string): Approval | undefined {
  const a = read(dir);
  if (!a || a.delivered) return undefined;
  writeFileSync(approvalFile(dir), JSON.stringify({ ...a, delivered: true }, null, 2) + "\n");
  return a;
}
