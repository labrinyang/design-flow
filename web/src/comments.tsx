import { Button, IconButton, Panel, Textarea } from "@astrafoundry/design/ui";
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { api, type FeatureState, type ViewThread } from "./api.ts";
import { t } from "./i18n.ts";

function ThreadView({ thread, state, active, onFocus }: { thread: ViewThread; state: FeatureState; active: boolean; onFocus: () => void }) {
  const [draft, setDraft] = useState("");
  const op = (o: "reply" | "resolve" | "reopen", body?: unknown) => api.thread(state.project, state.feature, thread.id, o, body);
  return (
    <li
      data-active={active}
      className="rounded-2xl p-3 transition-colors data-[active=true]:bg-accent/60"
      onMouseEnter={onFocus}
    >
      <button type="button" onClick={onFocus} className="mb-2 block w-full truncate text-left text-[12px] text-muted-foreground">
        <span className="mr-1.5 font-mono tabular-nums">#{thread.id.slice(0, 4)}</span>
        {thread.where}
      </button>
      <ul className="space-y-2">
        {thread.messages.map((m) => (
          <li key={m.id} className="text-[14px] leading-snug">
            <span className="mr-1.5 text-[12px] font-medium text-muted-foreground">{m.author === "agent" ? t.agent : t.you}</span>
            <span className="text-pretty">{m.text}</span>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void op("reply", { text: draft.trim() }).then(() => setDraft(""));
        }}
      >
        <Textarea
          aria-label={t.reply}
          placeholder={t.reply}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          className="min-h-9 flex-1 resize-none text-[13px]"
        />
        {thread.status === "open" ? (
          <Button size="sm" variant="secondary" type="button" onClick={() => void op("resolve")}>
            {t.resolve}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" type="button" onClick={() => void op("reopen")}>
            {t.reopen}
          </Button>
        )}
      </form>
    </li>
  );
}

export function CommentPanel({
  state,
  active,
  onFocus,
  onClose,
}: {
  state: FeatureState;
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
            <ThreadView key={th.id} thread={th} state={state} active={active === th.id} onFocus={() => onFocus(th.id)} />
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

export function NewComment({ onSubmit, onCancel, where }: { onSubmit: (text: string) => void; onCancel: () => void; where: string }) {
  const [text, setText] = useState("");
  return (
    <Panel className="w-72" onClick={(e) => e.stopPropagation()}>
      <p className="mb-2 truncate px-1 text-[12px] text-muted-foreground">{where}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSubmit(text.trim());
        }}
        className="space-y-2"
      >
        <Textarea
          autoFocus
          aria-label={t.writeComment}
          placeholder={t.writeComment}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          className="resize-none text-[14px]"
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" type="button" onClick={onCancel}>
            {t.cancel}
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>
            {t.send}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
