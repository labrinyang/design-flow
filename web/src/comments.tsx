import { cn } from "@astrafoundry/design";
import { ActorAvatar, Badge, IconButton, Panel, Segmented, Tooltip } from "@astrafoundry/design/ui";
import { ArrowUp, Check, ChevronDown, ChevronUp, CircleCheck, MessageSquare, RotateCcw, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { optionLetter, type Message } from "../../src/core/comments.ts";
import { anchorTitle, type AnchorTitle } from "./anchor.ts";
import { api, type FeatureState, type ViewThread } from "./api.ts";
import { sendsOnKey } from "./compose.ts";
import { locale, t } from "./i18n.ts";
import { firstNew, type SeenMap } from "./seen.ts";
import { exactTime, relativeTime } from "./time.ts";
import {
  ChatDeliveryIndicator,
  ChatMessageAvatar,
  ChatMessageContent,
  ChatMessageFooter,
  ChatMessageHeader,
  ChatMessageLayout,
  ChatUnreadDivider,
} from "./ui/chat.tsx";

/** The time now, again every minute, so "3 分钟前" stays true while the panel is open. */
function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function TimeAgo({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={exactTime(iso, locale)} className="tabular-nums">
      {relativeTime(iso, now, locale)}
    </time>
  );
}

/** The keys of a text field that sends, for its send button's tooltip. */
function SendKeys() {
  return (
    <span className="flex items-center gap-3">
      <span>{t.send} ↵</span>
      <span className="opacity-70">
        {t.newLine} ⇧ ↵
      </span>
    </span>
  );
}

/** A text field that sends on Enter, with its send button inside it; the keys are in the button's tooltip. */
function Composer({
  label,
  placeholder,
  rows = 1,
  autoFocus,
  focusKey,
  onSend,
  onEscape,
  onIdleBlur,
}: {
  label: string;
  placeholder: string;
  rows?: number;
  autoFocus?: boolean;
  /** With autoFocus: take the focus again whenever this changes. */
  focusKey?: unknown;
  onSend: (text: string) => Promise<unknown> | void;
  onEscape?: () => void;
  /** The field lost the focus with nothing typed in it. */
  onIdleBlur?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus, focusKey]);
  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    void Promise.resolve(onSend(v))
      .then(() => setText(""))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="material-field flex items-end gap-1 rounded-[14px] py-1 pr-1 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={field}
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          if (!text.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null)) onIdleBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onEscape?.();
          if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
            e.preventDefault();
            submit();
          }
        }}
        className="field-sizing-content max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/80"
      />
      <Tooltip content={<SendKeys />} side="bottom">
        <IconButton label={t.send} size="sm" variant={text.trim() ? "primary" : "ghost"} type="submit" disabled={!text.trim() || busy}>
          <ArrowUp size={16} />
        </IconButton>
      </Tooltip>
    </form>
  );
}

/** The reply field, folded to one quiet line until it is clicked, and folded again once sent or left empty. */
function ReplyBox({ onSend }: { onSend: (text: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        data-reply
        onClick={() => setOpen(true)}
        className="material-field flex h-9 w-full items-center rounded-[14px] px-3 text-left text-[14px] text-muted-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t.replyPlaceholder}
      </button>
    );
  return (
    <Composer
      label={t.reply}
      placeholder={t.reply}
      autoFocus
      onSend={(text) => onSend(text).then(() => setOpen(false))}
      onEscape={() => setOpen(false)}
      onIdleBlur={() => setOpen(false)}
    />
  );
}

/**
 * The options an agent message offers, as cards in a recessed tray: one click sends the pick to the agent
 * as your reply. Once picked they fold to one line naming the pick, which opens them again to change it.
 */
function Options({
  message,
  picked,
  open,
  onPick,
  after,
}: {
  message: Message;
  picked?: number;
  open: boolean;
  onPick: (option: number) => Promise<unknown>;
  /** Shown under the options, as the read mark when the pick is the thread's last word. */
  after?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = message.options!;
  if (picked !== undefined && !expanded)
    return (
      <div className="mt-1 flex flex-col gap-1">
        <button
          type="button"
          data-picked={picked}
          aria-expanded={false}
          disabled={!open}
          onClick={() => setExpanded(true)}
          className="material-well flex w-full items-center gap-2 rounded-[14px] px-3 py-2 text-left text-[14px] transition-colors duration-[120ms] ease-out enabled:hover:bg-foreground/5 disabled:cursor-default"
        >
          <Check size={15} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t.pickedLine(optionLetter(picked), options[picked] ?? "")}</span>
          {open && (
            <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-muted-foreground">
              {t.change}
              <ChevronDown size={14} aria-hidden />
            </span>
          )}
        </button>
        {after}
      </div>
    );
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div role="group" aria-label={t.options} className="material-well flex flex-col gap-1 rounded-[14px] p-1">
        {options.map((label, i) => {
          const chosen = picked === i;
          return (
            <button
              key={i}
              type="button"
              data-option={i}
              aria-pressed={chosen}
              disabled={!open || busy || chosen}
              onClick={() => {
                setBusy(true);
                void onPick(i)
                  .then(() => setExpanded(false))
                  .finally(() => setBusy(false));
              }}
              className={cn(
                "flex items-start gap-2.5 rounded-[10px] border border-transparent px-3 py-2.5 text-left transition-[background-color,scale] duration-[120ms] ease-out enabled:active:scale-[0.99] disabled:cursor-default",
                chosen ? "material-thumb" : "bg-foreground/[0.03] enabled:hover:bg-foreground/[0.07]",
              )}
            >
              <span className="w-3 shrink-0 pt-px font-mono text-[12px] leading-5 text-muted-foreground tabular-nums">{optionLetter(i)}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[14px] leading-5 text-pretty text-foreground">{label}</span>
                {(i === message.recommended || i === message.applied) && (
                  <span className="flex flex-wrap gap-1.5">
                    {i === message.recommended && <Badge>{t.recommended}</Badge>}
                    {i === message.applied && <Badge tone="success">{t.applied}</Badge>}
                  </span>
                )}
              </span>
              {chosen && <Check size={15} aria-hidden className="mt-0.5 shrink-0" />}
            </button>
          );
        })}
      </div>
      {picked !== undefined && (
        <button type="button" onClick={() => setExpanded(false)} className="self-start px-1 text-[12px] text-muted-foreground hover:text-foreground">
          {t.collapse}
        </button>
      )}
      {after}
    </div>
  );
}

function MessageRow({ m, now, footer, children }: { m: Message; now: number; footer?: ReactNode; children?: ReactNode }) {
  const agent = m.author === "agent";
  const name = agent ? t.agent : t.you;
  return (
    <ChatMessageLayout data-message data-author={m.author} aria-label={name}>
      <ChatMessageAvatar>
        <ActorAvatar name={name} kind={agent ? "agent" : "person"} size="sm" className={agent ? "bg-foreground text-background" : undefined} />
      </ChatMessageAvatar>
      <ChatMessageHeader>
        <span className="font-medium text-foreground">{name}</span>
        <TimeAgo iso={m.at} now={now} />
      </ChatMessageHeader>
      <ChatMessageContent>
        <p className="text-pretty whitespace-pre-wrap">{m.pick ? t.picked(optionLetter(m.pick.option)) : m.text}</p>
        {children}
      </ChatMessageContent>
      {footer && <ChatMessageFooter>{footer}</ChatMessageFooter>}
    </ChatMessageLayout>
  );
}

/** The pin's number, drawn like the pin, so a thread and its pin are easy to match. */
function PinBadge({ n }: { n: number }) {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full rounded-bl-none bg-substrate text-[12px] font-medium text-substrate-hi tabular-nums">
      {n}
    </span>
  );
}

function Where({ title }: { title: AnchorTitle }) {
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium text-foreground">{title.title}</span>
      {title.detail && <span className="ml-1.5 text-muted-foreground">{title.detail}</span>}
    </span>
  );
}

/** Calls onSeen once the end of a thread has been in view for a moment, and again as messages arrive. */
function useSeenWhenVisible(ref: RefObject<HTMLElement | null>, count: number, onSeen: (count: number) => void) {
  const latest = useRef(onSeen);
  latest.current = onSeen;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const io = new IntersectionObserver(([entry]) => {
      window.clearTimeout(timer);
      if (entry?.isIntersecting) timer = window.setTimeout(() => latest.current(count), 800);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [ref, count]);
}

function ThreadCard({
  thread,
  state,
  number,
  active,
  divider,
  now,
  onHover,
  onJump,
  onChange,
  onSeen,
  onCollapse,
}: {
  thread: ViewThread;
  state: FeatureState;
  /** The pin's number, for open threads. */
  number?: number;
  active: boolean;
  /** Index of the first message to show under the "new" divider. */
  divider?: number;
  now: number;
  onHover: () => void;
  onJump: () => void;
  onChange: (s: FeatureState) => void;
  onSeen: (count: number) => void;
  /** For a resolved thread opened from its line: fold it back. */
  onCollapse?: () => void;
}) {
  const op = (o: "reply" | "pick" | "resolve" | "reopen", body?: unknown) => api.thread(state.project, state.feature, thread.id, o, body).then(onChange);
  const open = thread.status === "open";
  const title = anchorTitle(thread.anchor, state.flow, locale);
  // Each offer's latest pick, and the user's last message (where the read mark goes).
  const picks = new Map<string, number>();
  let lastUser = -1;
  thread.messages.forEach((m, i) => {
    if (m.pick) picks.set(m.pick.message, m.pick.option);
    if (m.author === "user") lastUser = i;
  });
  const offers = new Set(thread.messages.filter((m) => m.options).map((m) => m.id));
  // Only while the thread waits on the agent: once it has answered, it has read.
  const waiting = open && lastUser >= 0 && lastUser === thread.messages.length - 1;
  const last = thread.messages[lastUser];
  const markOn = waiting ? (last?.pick && offers.has(last.pick.message) ? last.pick.message : last?.id) : undefined;
  const read = lastUser < thread.seen;
  const mark = <ChatDeliveryIndicator status={read ? "read" : "waiting"} label={read ? t.agentRead : t.agentUnread} />;
  const end = useRef<HTMLDivElement>(null);
  useSeenWhenVisible(end, thread.messages.length, onSeen);
  return (
    <li
      data-thread={thread.id}
      data-active={active}
      onMouseEnter={onHover}
      className="rounded-2xl p-3 transition-colors duration-[120ms] ease-out data-[active=true]:bg-foreground/[0.045]"
    >
      <div className="mb-3 flex items-center gap-0.5">
        <Tooltip content={t.threadTip(title.tip, thread.id.slice(0, 4))}>
          <button
            type="button"
            data-jump
            onClick={onJump}
            aria-label={t.showOnCanvas(`${title.title}${title.detail ? ` ${title.detail}` : ""}`)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {number !== undefined && <PinBadge n={number} />}
            <Where title={title} />
          </button>
        </Tooltip>
        {onCollapse && (
          <Tooltip content={t.collapse}>
            <IconButton label={t.collapse} size="sm" variant="ghost" onClick={onCollapse}>
              <ChevronUp size={16} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip content={open ? t.resolve : t.reopen}>
          <IconButton label={open ? t.resolve : t.reopen} size="sm" variant="ghost" className="-mr-1" onClick={() => void op(open ? "resolve" : "reopen")}>
            {open ? <CircleCheck size={17} /> : <RotateCcw size={15} />}
          </IconButton>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-3">
        {thread.messages.map((m, i) =>
          // A pick shows as the fold of the options it was made from.
          m.pick && offers.has(m.pick.message) ? null : (
            <Fragment key={m.id}>
              {i === divider && <ChatUnreadDivider>{t.newDivider}</ChatUnreadDivider>}
              <MessageRow m={m} now={now} footer={markOn === m.id && !m.options ? mark : undefined}>
                {m.options && (
                  <Options
                    message={m}
                    picked={picks.get(m.id)}
                    open={open}
                    onPick={(option) => op("pick", { message: m.id, option })}
                    after={markOn === m.id ? <span className="px-1 pt-0.5 text-[12px] text-muted-foreground">{mark}</span> : undefined}
                  />
                )}
              </MessageRow>
            </Fragment>
          ),
        )}
      </div>
      <div ref={end} />
      {open && (
        <div className="mt-3">
          <ReplyBox onSend={(text) => op("reply", { text })} />
        </div>
      )}
    </li>
  );
}

/** A resolved thread as one line; it opens in place. */
function ResolvedRow({ thread, state, now, onExpand }: { thread: ViewThread; state: FeatureState; now: number; onExpand: () => void }) {
  const title = anchorTitle(thread.anchor, state.flow, locale);
  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  return (
    <li data-thread={thread.id}>
      <button
        type="button"
        aria-expanded={false}
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors duration-[120ms] ease-out hover:bg-foreground/[0.045]"
      >
        <CircleCheck size={15} aria-hidden className="shrink-0" style={{ color: "var(--success)" }} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{title.title}</span>
          {first && <span className="ml-1.5 text-muted-foreground">{first.pick ? t.picked(optionLetter(first.pick.option)) : first.text}</span>}
        </span>
        {last && (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            <TimeAgo iso={last.at} now={now} />
          </span>
        )}
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

export type CommentFilter = "open" | "resolved" | "new";

export function CommentPanel({
  state,
  active,
  numbers,
  seen,
  seenReady,
  onSeen,
  onHover,
  onJump,
  onClose,
  onChange,
}: {
  state: FeatureState;
  active?: string;
  /** Each open thread's pin number. */
  numbers: Map<string, number>;
  /** How far the user has looked at each thread. */
  seen: SeenMap;
  seenReady: boolean;
  onSeen: (id: string, count: number) => void;
  onHover: (id: string) => void;
  onJump: (id: string) => void;
  onClose: () => void;
  onChange: (s: FeatureState) => void;
}) {
  const now = useNow();
  const [filter, setFilter] = useState<CommentFilter>("open");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Where each thread's "new" divider sits while the panel is open: it stays put once the replies count as seen.
  const dividers = useRef(new Map<string, number | null>());
  const dividerOf = (th: ViewThread): number | undefined => {
    if (!seenReady) return undefined;
    const now = firstNew(th.messages, seen[th.id]);
    const had = dividers.current.get(th.id);
    if (had === undefined || (had === null && now !== undefined)) {
      dividers.current.set(th.id, now ?? null);
      return now;
    }
    return had ?? undefined;
  };
  const threads = state.threads;
  const orphans = threads.filter((x) => x.orphan && x.status === "open");
  const open = threads.filter((x) => !x.orphan && x.status === "open");
  const resolved = threads.filter((x) => x.status === "resolved");
  const fresh = threads.filter((x) => dividerOf(x) !== undefined);

  // A thread picked on the canvas or from a link shows in a list that has it, scrolled into view.
  const activeThread = active ? threads.find((x) => x.id === active) : undefined;
  useEffect(() => {
    if (!activeThread) return;
    if (activeThread.status === "resolved") {
      setFilter((f) => (f === "new" ? f : "resolved"));
      setExpanded((s) => new Set(s).add(activeThread.id));
    } else setFilter((f) => (f === "resolved" ? "open" : f));
    const id = requestAnimationFrame(() =>
      document.querySelector(`[data-comment-panel] [data-thread="${CSS.escape(activeThread.id)}"]`)?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
    // Only when another thread is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const card = (th: ViewThread, collapse?: () => void) => (
    <ThreadCard
      key={th.id}
      thread={th}
      state={state}
      number={numbers.get(th.id)}
      active={active === th.id}
      divider={dividerOf(th)}
      now={now}
      onHover={() => onHover(th.id)}
      onJump={() => onJump(th.id)}
      onChange={onChange}
      onSeen={(count) => onSeen(th.id, count)}
      onCollapse={collapse}
    />
  );
  const toggle = (id: string, on: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const empty = (text: string) => (
    <p className="flex gap-2 px-3 py-6 text-[14px] text-muted-foreground">
      <MessageSquare size={16} className="mt-0.5 shrink-0" />
      {text}
    </p>
  );

  return (
    <Panel data-comment-panel className="absolute top-3 right-3 bottom-3 z-10 flex w-[22rem] flex-col">
      <div className="flex items-center justify-between px-3 pt-1 pb-2">
        <h2 className="text-[16px] font-medium">{t.comments}</h2>
        <IconButton label={t.close} size="sm" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {threads.length > 0 && (
        <div className="px-1 pb-2">
          <Segmented
            label={t.filterLabel}
            value={filter}
            onValueChange={setFilter}
            className="w-full"
            options={[
              { value: "open", label: t.filterOpen(open.length + orphans.length) },
              { value: "resolved", label: t.filterResolved(resolved.length) },
              { value: "new", label: t.filterNew(fresh.length) },
            ]}
          />
        </div>
      )}
      <div className="-mx-1 flex-1 overflow-y-auto px-1">
        {threads.length === 0 && empty(t.noComments)}
        {threads.length > 0 && filter === "open" && (
          <>
            {open.length + orphans.length === 0 && empty(t.noOpen)}
            <ul className="flex flex-col gap-1">{open.map((th) => card(th))}</ul>
            {orphans.length > 0 && (
              <section>
                <h3 className="px-3 pt-3 pb-1 text-[12px] font-medium text-muted-foreground">{t.orphaned}</h3>
                <ul className="flex flex-col gap-1">{orphans.map((th) => card(th))}</ul>
              </section>
            )}
          </>
        )}
        {threads.length > 0 && filter === "resolved" && (
          <>
            {resolved.length === 0 && empty(t.noResolved)}
            <ul className="flex flex-col gap-0.5">
              {resolved.map((th) =>
                expanded.has(th.id) ? (
                  card(th, () => toggle(th.id, false))
                ) : (
                  <ResolvedRow key={th.id} thread={th} state={state} now={now} onExpand={() => toggle(th.id, true)} />
                ),
              )}
            </ul>
          </>
        )}
        {threads.length > 0 && filter === "new" && (
          <>
            {fresh.length === 0 && empty(t.noNew)}
            <ul className="flex flex-col gap-1">{fresh.map((th) => card(th))}</ul>
          </>
        )}
      </div>
    </Panel>
  );
}

/** The box for a new comment. When the user clicks elsewhere it moves there with the text so far, and keeps the focus. */
export function NewComment({
  onSubmit,
  onCancel,
  title,
  focusKey,
}: {
  onSubmit: (text: string) => Promise<unknown> | void;
  onCancel: () => void;
  /** What the comment will be on, in words; the ids are in its tooltip. */
  title: AnchorTitle;
  /** The anchor: a new one means the box moved, and its field takes the focus again. */
  focusKey?: unknown;
}) {
  return (
    <Panel
      className="w-80"
      onClick={(e) => e.stopPropagation()}
      // Clicking the box's own empty space keeps the text field focused.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("button, textarea, input, a, [tabindex]")) e.preventDefault();
      }}
    >
      <div className="mb-2 flex items-center gap-2 pl-1">
        <Tooltip content={title.tip}>
          <p tabIndex={0} data-where className="flex min-w-0 flex-1 text-[13px] outline-none">
            <Where title={title} />
          </p>
        </Tooltip>
        <IconButton label={t.cancel} size="sm" variant="ghost" onClick={onCancel}>
          <X size={15} />
        </IconButton>
      </div>
      <Composer label={t.writeComment} placeholder={t.writeComment} rows={2} autoFocus focusKey={focusKey} onSend={onSubmit} onEscape={onCancel} />
    </Panel>
  );
}
