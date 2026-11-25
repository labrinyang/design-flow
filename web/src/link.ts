/** What the canvas URL's hash points at: a comment thread, or else a screen. */
export interface Link {
  screen?: string;
  thread?: string;
}

export function parseLink(hash: string): Link {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const thread = p.get("thread") || undefined;
  const screen = p.get("screen") || undefined;
  return thread ? { thread } : screen ? { screen } : {};
}

/** "#thread=…" or "#screen=…", or "" for no target; a thread wins over a screen. */
export function formatLink(link: Link): string {
  const p = new URLSearchParams();
  if (link.thread) p.set("thread", link.thread);
  else if (link.screen) p.set("screen", link.screen);
  const s = p.toString();
  return s ? `#${s}` : "";
}
