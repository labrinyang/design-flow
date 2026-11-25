/*
 * Message layout, delivery indicator and unread divider, adapted from coss ui
 * (https://github.com/cosscom/ui, packages/ui/src/chat), MIT License,
 * Copyright (c) 2025 coss.com and Origin UI.
 * Changed for design-flow: plain elements instead of Base UI's useRender, Sunbeam tokens, the avatar
 * beside the name line as in a comment thread, and no text under 12px.
 */
import { cn } from "@astrafoundry/design";
import { CheckCheck, Clock } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";

/** One message: an avatar column, then a header line, the content and an optional footer. */
export function ChatMessageLayout({ className, ...props }: ComponentProps<"article">): ReactElement {
  return (
    <article
      data-slot="chat-message"
      className={cn("group/message relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5", className)}
      {...props}
    />
  );
}

export function ChatMessageAvatar({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="chat-message-avatar" className={cn("col-start-1 row-span-3 row-start-1 pt-px", className)} {...props} />;
}

export function ChatMessageHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-header"
      className={cn("col-start-2 row-start-1 flex min-w-0 items-baseline gap-2 text-[12px] leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ChatMessageContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-content"
      className={cn("col-start-2 row-start-2 flex min-w-0 flex-col gap-1.5 text-[14px] leading-snug text-foreground", className)}
      {...props}
    />
  );
}

export function ChatMessageFooter({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-footer"
      className={cn("col-start-2 row-start-3 flex items-center gap-1.5 pt-1 text-[12px] text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Whether a message has reached its reader: a clock while it waits, a double check once read. */
export function ChatDeliveryIndicator({ status, label }: { status: "waiting" | "read"; label: string }): ReactElement {
  const Icon = status === "read" ? CheckCheck : Clock;
  return (
    <span data-slot="chat-delivery-indicator" data-read={status === "read"} className="inline-flex items-center gap-1">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

/** A rule with a short label across the thread, before the first message the reader has not seen. */
export function ChatUnreadDivider({ children, className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-unread-divider"
      role="separator"
      className={cn("flex items-center gap-3 text-[12px] font-medium text-foreground", className)}
      {...props}
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      {children}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
