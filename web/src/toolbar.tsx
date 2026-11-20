import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
  Button,
  DialogFooter,
  IconButton,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Panel,
  Toggle,
} from "@astrafoundry/design/ui";
import { useReactFlow, useViewport } from "@xyflow/react";
import { Check, ChevronUp, LayoutGrid, Maximize, MessageSquare, MessageSquarePlus, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { approveButton } from "./approve-button.ts";
import type { FeatureState } from "./api.ts";
import { t } from "./i18n.ts";

/** The canvas's tools, floating at the bottom: comment, comments, zoom, a menu for the rest, approve. */
export function Toolbar({
  state,
  commenting,
  setCommenting,
  onTogglePanel,
  onRelayout,
  onApprove,
}: {
  state: FeatureState;
  commenting: boolean;
  setCommenting: (v: boolean) => void;
  onTogglePanel: () => void;
  onRelayout: () => void;
  onApprove: () => Promise<void>;
}) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(false);
  const openCount = state.threads.filter((x) => x.status === "open").length;
  const approval = approveButton(state.status, { hasFlow: !!state.flow, issues: state.issues.length });

  return (
    <Panel
      data-toolbar
      className="nodrag nopan nowheel absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-[22px] p-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <Toggle aria-label={t.comment} title={`${t.comment} (C)`} pressed={commenting} onPressedChange={setCommenting} size="sm">
        <MessageSquarePlus size={16} />
      </Toggle>
      <Button size="sm" variant="ghost" aria-label={t.comments} onClick={onTogglePanel}>
        <MessageSquare size={15} />
        <span className="tabular-nums">{openCount}</span>
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      <IconButton label={t.zoomOut} size="sm" variant="ghost" onClick={() => rf.zoomOut({ duration: 150 })}>
        <Minus size={16} />
      </IconButton>
      <Menu>
        <MenuTrigger
          render={<Button size="sm" variant="ghost" aria-label={t.zoomMenu} className="min-w-16 tabular-nums" />}
        >
          {Math.round(zoom * 100)}%
          <ChevronUp size={13} className="text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup side="top" sideOffset={10}>
          <MenuItem onClick={() => rf.fitView({ padding: 0.06, duration: 200 })}>
            <Maximize size={15} />
            {t.fit}
          </MenuItem>
          <MenuItem onClick={() => rf.zoomTo(1, { duration: 200 })}>
            <span className="w-[15px] text-center text-[12px]">1:1</span>
            {t.actualSize}
          </MenuItem>
          <MenuItem onClick={onRelayout}>
            <LayoutGrid size={15} />
            {t.relayout}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <IconButton label={t.zoomIn} size="sm" variant="ghost" onClick={() => rf.zoomIn({ duration: 150 })}>
        <Plus size={16} />
      </IconButton>
      <span className="mx-1 h-5 w-px bg-border" />
      <Button size="sm" variant={approval.variant} disabled={approval.disabled} onClick={() => setApproving(true)}>
        {approval.label === "approved" && <Check size={15} />}
        {t[approval.label]}
      </Button>
      <AlertDialog
        open={approving}
        onOpenChange={(o) => {
          setApproving(o);
          setApproveError(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogTitle>{t.approveTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.approveBody(openCount)}</AlertDialogDescription>
          {approveError && (
            <p role="alert" className="text-[14px]" style={{ color: "var(--danger)" }}>
              {t.approveChanged}
            </p>
          )}
          <DialogFooter>
            <AlertDialogClose render={<Button variant="secondary" />}>{t.cancel}</AlertDialogClose>
            <Button
              variant="primary"
              onClick={() =>
                void onApprove().then(
                  () => setApproving(false),
                  () => setApproveError(true),
                )
              }
            >
              {t.approve}
            </Button>
          </DialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Panel>
  );
}
