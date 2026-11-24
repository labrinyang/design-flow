import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalStatus, approve, markApprovalSeen, unseenApproval } from "../src/core/approval.ts";
import { CommentStore } from "../src/core/comments.ts";

function feature() {
  const dir = mkdtempSync(join(tmpdir(), "df-approval-"));
  writeFileSync(join(dir, "flow.yaml"), "version: 1\ntitle: T\nscreens: [{ id: A, title: A }]\n");
  return dir;
}

describe("approval", () => {
  it("is draft until approved", () => {
    expect(approvalStatus(feature()).status).toBe("draft");
  });

  it("is approved after approve and stale after the spec changes", () => {
    const dir = feature();
    approve(dir);
    expect(approvalStatus(dir).status).toBe("approved");
    writeFileSync(join(dir, "flow.yaml"), "version: 1\ntitle: T2\nscreens: [{ id: A, title: A }]\n");
    expect(approvalStatus(dir).status).toBe("stale");
  });

  it("goes stale when prototype.html changes after approval, since it holds the screens", () => {
    const dir = feature();
    writeFileSync(join(dir, "prototype.html"), `<section data-screen="A">v1</section>`);
    approve(dir);
    expect(approvalStatus(dir).status).toBe("approved");
    writeFileSync(join(dir, "prototype.html"), `<section data-screen="A">v2</section>`);
    expect(approvalStatus(dir).status).toBe("stale");
  });

  it("counts open threads", () => {
    const dir = feature();
    const s = CommentStore.load(dir);
    s.addThread({ type: "canvas", point: { x: 0, y: 0 } }, "a");
    const t = s.addThread({ type: "canvas", point: { x: 0, y: 0 } }, "b");
    s.resolve(t.id);
    expect(approvalStatus(dir).openThreads).toBe(1);
  });

  it("stays unseen until the agent is shown it, and only while it covers the spec", () => {
    const dir = feature();
    expect(unseenApproval(dir)).toBeUndefined();
    const a = approve(dir);
    expect(unseenApproval(dir)).toMatchObject({ sha256: a.sha256 });
    expect(unseenApproval(dir)).toMatchObject({ sha256: a.sha256 });
    markApprovalSeen(dir, a);
    expect(unseenApproval(dir)).toBeUndefined();
    expect(approvalStatus(dir).status).toBe("approved");
    // A new approval is news again, unless the spec changed under it.
    approve(dir);
    expect(unseenApproval(dir)).toBeDefined();
    writeFileSync(join(dir, "flow.yaml"), "version: 1\ntitle: T2\nscreens: [{ id: A, title: A }]\n");
    expect(unseenApproval(dir)).toBeUndefined();
  });

  it("does not mark a newer approval seen", async () => {
    const dir = feature();
    const first = approve(dir);
    await new Promise((r) => setTimeout(r, 5));
    approve(dir);
    markApprovalSeen(dir, first);
    expect(unseenApproval(dir)).toBeDefined();
  });

  it("counts an older file's delivered flag as seen", () => {
    const dir = feature();
    const a = approve(dir);
    writeFileSync(join(dir, "approval.json"), JSON.stringify({ ...a, delivered: true }));
    expect(unseenApproval(dir)).toBeUndefined();
  });
});
