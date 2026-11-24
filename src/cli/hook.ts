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
