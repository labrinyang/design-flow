import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalStatus, approve, takeApprovalEvent } from "../src/core/approval.ts";
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

  it("emits the approval event to the agent once", () => {
    const dir = feature();
    expect(takeApprovalEvent(dir)).toBeUndefined();
    approve(dir);
    expect(takeApprovalEvent(dir)).toMatchObject({ sha256: expect.any(String) });
    expect(takeApprovalEvent(dir)).toBeUndefined();
  });
});
