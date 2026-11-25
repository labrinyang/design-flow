import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markApprovalSeen, unseenApproval } from "../core/approval.ts";
import { CommentStore, describeAnchor, type Locale } from "../core/comments.ts";
import { parseFlow } from "../core/flow.ts";

const locale = (): Locale =>
  (process.env.DESIGN_FLOW_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale).startsWith("zh") ? "zh" : "en";

/**
 * Claude Code UserPromptSubmit hook: attach the comments and approvals the agent has not read. Reads local
 * files only, so it works with the server down. What it prints is marked read only once it is written.
 */
export async function hook(dir: string): Promise<number> {
  const root = join(dir, ".design-flow");
  if (!existsSync(root)) return 0;
  const lines: string[] = [];
  const marks: (() => void)[] = [];
  for (const f of readdirSync(root).sort()) {
    const fd = join(root, f);
    if (!existsSync(join(fd, "flow.yaml"))) continue;
    const flow = parseFlow(readFileSync(join(fd, "flow.yaml"), "utf8"), "").flow;
    const store = CommentStore.load(fd);
    const fresh = store.unread();
    for (const d of fresh)
      lines.push(`- ${f} #${d.threadId} on ${flow ? describeAnchor(d.anchor, flow, locale()) : "?"}: ${d.text}`);
    if (fresh.length) {
      lines.push(`  → apply them to .design-flow/${f}/flow.yaml, then run: design-flow comments ${f}`);
      marks.push(() => store.markRead(fresh.map((d) => d.threadId)));
    }
    const a = unseenApproval(fd);
    if (a) {
      lines.push(`- ${f}: APPROVED by the user (flow.yaml ${a.sha256.slice(0, 8)}). You may start coding this feature.`);
      marks.push(() => markApprovalSeen(fd, a));
    }
  }
  if (!lines.length) return 0;
  const additionalContext = `New Design Flow feedback from the canvas:\n${lines.join("\n")}`;
  await new Promise<void>((done, fail) =>
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }), (e) => (e ? fail(e) : done())),
  );
  for (const mark of marks) mark();
  return 0;
}

/**
 * Claude Code Stop hook: while the user has written on the canvas and the agent has not read it, the agent goes on
 * instead of stopping, told how many messages wait on which features and the command that shows them. It prints no
 * message text, so it marks nothing read. When a stop hook already sent the agent on (stop_hook_active), it lets
 * it stop, so a message the agent leaves unread cannot hold it in a loop.
 */
export async function stopHook(dir: string, input: Record<string, unknown>): Promise<number> {
  if (input.stop_hook_active === true) return 0;
  const root = join(dir, ".design-flow");
  if (!existsSync(root)) return 0;
  const waiting: { feature: string; count: number }[] = [];
  for (const f of readdirSync(root).sort()) {
    if (!existsSync(join(root, f, "flow.yaml"))) continue;
    const count = CommentStore.load(join(root, f)).unread().length;
    if (count) waiting.push({ feature: f, count });
  }
  if (!waiting.length) return 0;
  const total = waiting.reduce((n, w) => n + w.count, 0);
  const where = waiting.map((w) => `${w.count} on ${w.feature}`).join(", ");
  const read = waiting.map((w) => `design-flow comments ${w.feature}`).join(", then ");
  // additionalContext rather than decision "block": the hooks docs advise it for a hook that guides Claude as designed.
  // It keeps Claude going with the same loop protection, and the transcript shows it as feedback, not a hook error.
  const additionalContext = `The user has ${total} unread message${total === 1 ? "" : "s"} for you on the Design Flow canvas (${where}). Read ${total === 1 ? "it" : "them"} with ${read}, and answer before you stop.`;
  await new Promise<void>((done, fail) =>
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }), (e) => (e ? fail(e) : done())),
  );
  return 0;
}
