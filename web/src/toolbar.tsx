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
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Panel,
  Toggle,
} from "@astrafoundry/design/ui";
import { useReactFlow, useViewport } from "@xyflow/react";
import { Check, ChevronsDownUp, ChevronsUpDown, ChevronUp, Maximize, MessageSquare, MessageSquarePlus, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { approveButton } from "./approve-button.ts";
import type { FeatureState } from "./api.ts";
import { t } from "./i18n.ts";
import { IS_MAC } from "./zoom.ts";

const MOD = IS_MAC ? "⌘" : "Ctrl ";

/** The canvas's tools, floating at the bottom: comment, comments, zoom, a menu for the rest, approve. */
export function Toolbar({
  state,
  commenting,
  setCommenting,
  onTogglePanel,
  onFit,
  onActualSize,
  onApprove,
  newReplies,
  minimap,
  setMinimap,
  lanes,
  onCollapseAll,
  onExpandAll,
}: {
  state: FeatureState;
  commenting: boolean;
  setCommenting: (v: boolean) => void;
  onTogglePanel: () => void;
  onFit: () => void;
  onActualSize: () => void;
  onApprove: () => Promise<void>;
  /** Threads with agent replies the user has not looked at yet. */
  newReplies: number;
  minimap: boolean;
  setMinimap: (on: boolean) => void;
  /** How many lanes the board has, and how many of them are collapsed. */
  lanes: { total: number; collapsed: number };
  onCollapseAll: () => void;
  onExpandAll: () => void;
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
      <Button size="sm" variant="ghost" aria-label={newReplies ? t.commentsWithNew(newReplies) : t.comments} onClick={onTogglePanel} className="relative">
        <MessageSquare size={15} />
        <span className="tabular-nums">{openCount}</span>
        {newReplies > 0 && (
          <span
            data-new-replies
            className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-1 text-[12px] leading-none font-medium text-background tabular-nums"
          >
            {newReplies}
          </span>
        )}
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      <IconButton label={t.zoomOut} title={`${t.zoomOut} (${MOD}−)`} size="sm" variant="ghost" onClick={() => rf.zoomOut({ duration: 150 })}>
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
          <MenuItem onClick={onFit} shortcut={`${MOD}0`}>
            <Maximize size={15} />
            {t.fit}
          </MenuItem>
          <MenuItem onClick={onActualSize}>
            <span className="w-[15px] text-center text-[12px]">1:1</span>
            {t.actualSize}
          </MenuItem>
          {lanes.total > 0 && (
            <>
              <MenuSeparator />
              <MenuItem onClick={onCollapseAll} disabled={lanes.collapsed === lanes.total}>
                <ChevronsDownUp size={15} />
                {t.collapseAll}
              </MenuItem>
              <MenuItem onClick={onExpandAll} disabled={lanes.collapsed === 0}>
                <ChevronsUpDown size={15} />
                {t.expandAll}
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuCheckboxItem checked={minimap} onCheckedChange={setMinimap}>
            {t.minimap}
          </MenuCheckboxItem>
        </MenuPopup>
      </Menu>
      <IconButton label={t.zoomIn} title={`${t.zoomIn} (${MOD}+)`} size="sm" variant="ghost" onClick={() => rf.zoomIn({ duration: 150 })}>
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
