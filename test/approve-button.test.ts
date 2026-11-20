import { describe, expect, it } from "vitest";
import { approveButton } from "../web/src/approve-button.ts";

const draft = { status: "draft", openThreads: 0 } as const;
const stale = { status: "stale", openThreads: 0 } as const;
const approved = { status: "approved", openThreads: 0 } as const;

describe("approveButton", () => {
  it("asks for approval on a clean draft", () => {
    expect(approveButton(draft, { hasFlow: true, issues: 0 })).toEqual({ label: "approve", variant: "primary", disabled: false });
  });
  it("asks again, by name, once the flow changed after approval", () => {
    expect(approveButton(stale, { hasFlow: true, issues: 0 })).toEqual({ label: "reapprove", variant: "primary", disabled: false });
  });
  it("shows the approval as done, not as an action, once approved", () => {
    expect(approveButton(approved, { hasFlow: true, issues: 0 })).toEqual({ label: "approved", variant: "secondary", disabled: true });
  });
  it("cannot be pressed while the flow has problems or is missing", () => {
    expect(approveButton(draft, { hasFlow: true, issues: 2 })).toEqual({ label: "approve", variant: "primary", disabled: true });
    expect(approveButton(stale, { hasFlow: false, issues: 0 })).toEqual({ label: "reapprove", variant: "primary", disabled: true });
  });
});
