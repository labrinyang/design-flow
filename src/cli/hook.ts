import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { takeApprovalEvent } from "../core/approval.ts";
import { CommentStore, describeAnchor, type Locale } from "../core/comments.ts";
import { parseFlow } from "../core/flow.ts";

const locale = (): Locale =>
  (process.env.DESIGN_FLOW_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale).startsWith("zh") ? "zh" : "en";

/**
 * Claude Code UserPromptSubmit hook: attach comments and approvals the agent
 * has not seen yet. Reads local files only, so it works with the server down.
 */
export async function hook(dir: string): Promise<number> {
  const root = join(dir, ".design-flow");
  if (!existsSync(root)) return 0;
  const lines: string[] = [];
  for (const f of readdirSync(root).sort()) {
    const fd = join(root, f);
    if (!existsSync(join(fd, "flow.yaml"))) continue;
    const flow = parseFlow(readFileSync(join(fd, "flow.yaml"), "utf8"), "").flow;
    const fresh = CommentStore.load(fd).takeUndelivered();
    for (const d of fresh)
      lines.push(`- ${f} #${d.threadId} on ${flow ? describeAnchor(d.anchor, flow, locale()) : "?"}: ${d.text}`);
    if (fresh.length) lines.push(`  → apply them to .design-flow/${f}/flow.yaml, then run: design-flow comments ${f}`);
    const a = takeApprovalEvent(fd);
    if (a) lines.push(`- ${f}: APPROVED by the user (flow.yaml ${a.sha256.slice(0, 8)}). You may start coding this feature.`);
  }
  if (!lines.length) return 0;
  const additionalContext = `New Design Flow feedback from the canvas:\n${lines.join("\n")}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }));
  return 0;
}
