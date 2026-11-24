import { IconButton, Kbd, Panel } from "@astrafoundry/design/ui";
import { ArrowUp, CircleCheck, MessageSquare, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type FeatureState, type ViewThread } from "./api.ts";
import { sendsOnKey } from "./compose.ts";
import { t } from "./i18n.ts";

/** A text field that sends on Enter, with its send button inside it. */
function Composer({
  label,
  placeholder,
  rows = 1,
  autoFocus,
  focusKey,
  onSend,
  onEscape,
}: {
  label: string;
  placeholder: string;
  rows?: number;
  autoFocus?: boolean;
  /** With autoFocus: take the focus again whenever this changes. */
  focusKey?: unknown;
  onSend: (text: string) => Promise<unknown> | void;
  onEscape?: () => void;
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
        onKeyDown={(e) => {
          if (e.key === "Escape") onEscape?.();
          if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
            e.preventDefault();
            submit();
          }
        }}
        className="field-sizing-content max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/80"
      />
      <IconButton label={t.send} size="sm" variant={text.trim() ? "primary" : "ghost"} type="submit" disabled={!text.trim() || busy}>
        <ArrowUp size={16} />
      </IconButton>
    </form>
  );
}

function ThreadView({
  thread,
  state,
  active,
  onFocus,
  onChange,
}: {
  thread: ViewThread;
  state: FeatureState;
  active: boolean;
  onFocus: () => void;
  onChange: (s: FeatureState) => void;
}) {
  const op = (o: "reply" | "resolve" | "reopen", body?: unknown) => api.thread(state.project, state.feature, thread.id, o, body).then(onChange);
  const open = thread.status === "open";
  return (
    <li
      data-active={active}
      data-thread={thread.id}
      className="rounded-2xl p-3 transition-colors data-[active=true]:bg-accent/60"
      onMouseEnter={onFocus}
    >
      <div className="mb-2 flex items-start gap-2">
        <button type="button" onClick={onFocus} className="min-w-0 flex-1 truncate pt-1 text-left text-[12px] text-muted-foreground">
          <span className="mr-1.5 font-mono tabular-nums">#{thread.id.slice(0, 4)}</span>
          {thread.where}
        </button>
        {open ? (
          <IconButton label={t.resolve} title={t.resolve} size="sm" variant="ghost" className="-mt-1 -mr-1" onClick={() => void op("resolve")}>
            <CircleCheck size={17} />
          </IconButton>
        ) : (
          <IconButton label={t.reopen} title={t.reopen} size="sm" variant="ghost" className="-mt-1 -mr-1" onClick={() => void op("reopen")}>
            <RotateCcw size={15} />
          </IconButton>
        )}
      </div>
      <ul className="space-y-2.5">
        {thread.messages.map((m) => (
          <li key={m.id} data-message className="text-[14px] leading-snug">
            <div className="mb-0.5 text-[12px] font-medium text-muted-foreground">{m.author === "agent" ? t.agent : t.you}</div>
            <p className="text-pretty whitespace-pre-wrap">{m.text}</p>
          </li>
        ))}
      </ul>
      {open && (
        <div className="mt-3">
          <Composer label={t.reply} placeholder={t.reply} onSend={(text) => op("reply", { text })} />
        </div>
      )}
    </li>
  );
}

export function CommentPanel({
  state,
  active,
  onFocus,
  onClose,
  onChange,
}: {
  state: FeatureState;
  onChange: (s: FeatureState) => void;
  active?: string;
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const orphans = state.threads.filter((x) => x.orphan && x.status === "open");
  const open = state.threads.filter((x) => !x.orphan && x.status === "open");
  const resolved = state.threads.filter((x) => x.status === "resolved");
  const section = (title: string | undefined, list: ViewThread[]) =>
    list.length > 0 && (
      <section>
        {title && <h3 className="px-3 pt-3 pb-1 text-[12px] font-medium text-muted-foreground">{title}</h3>}
        <ul>
          {list.map((th) => (
            <ThreadView key={th.id} thread={th} state={state} active={active === th.id} onFocus={() => onFocus(th.id)} onChange={onChange} />
          ))}
        </ul>
      </section>
    );
  return (
    <Panel data-comment-panel className="absolute top-3 right-3 bottom-3 z-10 flex w-[22rem] flex-col">
      <div className="flex items-center justify-between px-3 pt-1 pb-2">
        <h2 className="text-[16px] font-medium">{t.comments}</h2>
        <IconButton label={t.close} size="sm" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="-mx-1 flex-1 overflow-y-auto px-1">
        {state.threads.length === 0 && (
          <p className="flex gap-2 px-3 py-6 text-[14px] text-muted-foreground">
            <MessageSquare size={16} className="mt-0.5 shrink-0" />
            {t.noComments}
          </p>
        )}
        {section(t.orphaned, orphans)}
        {section(undefined, open)}
        {section(t.resolved, resolved)}
      </div>
    </Panel>
  );
}

/** The box for a new comment. When the user clicks elsewhere it moves there with the text so far, and keeps the focus. */
export function NewComment({
  onSubmit,
  onCancel,
  where,
  focusKey,
}: {
  onSubmit: (text: string) => Promise<unknown> | void;
  onCancel: () => void;
  where: string;
  /** The anchor: a new one means the box moved, and its field takes the focus again. */
  focusKey?: unknown;
}) {
  return (
    <Panel
      className="w-80"
      onClick={(e) => e.stopPropagation()}
      // Clicking the box's own empty space keeps the text field focused.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("button, textarea, input, a")) e.preventDefault();
      }}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{where}</p>
        <IconButton label={t.cancel} size="sm" variant="ghost" onClick={onCancel}>
          <X size={15} />
        </IconButton>
      </div>
      <Composer label={t.writeComment} placeholder={t.writeComment} rows={2} autoFocus focusKey={focusKey} onSend={onSubmit} onEscape={onCancel} />
      <p className="mt-2 flex items-center gap-1 px-1 text-[12px] text-muted-foreground">
        <Kbd>↵</Kbd>
        <span className="mr-2">{t.toSend}</span>
        <Kbd>⇧</Kbd>
        <Kbd>↵</Kbd>
        <span>{t.newLine}</span>
      </p>
    </Panel>
  );
}
