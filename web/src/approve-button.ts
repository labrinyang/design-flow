import type { FeatureState } from "./api.ts";

export interface ApproveButton {
  /** Key into the i18n strings: the button says what pressing it does, or that it is done. */
  label: "approve" | "reapprove" | "approved";
  variant: "primary" | "secondary";
  disabled: boolean;
}

/** The approval state lives in the Approve button itself: no separate status badge. */
export function approveButton(status: FeatureState["status"], flow: { hasFlow: boolean; issues: number }): ApproveButton {
  if (status.status === "approved") return { label: "approved", variant: "secondary", disabled: true };
  return {
    label: status.status === "stale" ? "reapprove" : "approve",
    variant: "primary",
    disabled: !flow.hasFlow || flow.issues > 0,
  };
}
