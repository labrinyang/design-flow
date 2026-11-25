import type { Message } from "../../src/core/comments.ts";

/**
 * How many messages of each thread the user has looked at, kept per feature on this browser. It decides
 * where the "new" divider goes and which threads count as having new replies. (The agent's own read
 * state, `seen` on each thread, is a different thing and lives on the server.)
 */
export type SeenMap = Record<string, number>;

export const seenKey = (project: string, feature: string) => `design-flow:seen:${project}:${feature}`;

/** Index of the first agent message at or after `seen`, if there is one. */
export function firstNew(messages: readonly Pick<Message, "author">[], seen: number | undefined): number | undefined {
  for (let i = Math.max(0, seen ?? 0); i < messages.length; i++) if (messages[i].author === "agent") return i;
  return undefined;
}

/** On a browser that has never shown the feature, what is already there counts as seen. */
export function baseline(threads: readonly { id: string; messages: readonly unknown[] }[]): SeenMap {
  return Object.fromEntries(threads.map((t) => [t.id, t.messages.length]));
}

export function readSeen(storage: Pick<Storage, "getItem">, key: string): SeenMap | undefined {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return undefined;
  }
}
