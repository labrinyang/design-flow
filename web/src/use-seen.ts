import { useCallback, useEffect, useState } from "react";
import type { Thread } from "../../src/core/comments.ts";
import { baseline, readSeen, seenKey, type SeenMap } from "./seen.ts";

function save(key: string, value: SeenMap) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: the record lasts for this page only */
  }
}

/** How far the user has looked at each thread of a feature on this browser (see seen.ts), shared between its tabs. */
export function useUserSeen(project: string, feature: string, threads: readonly Thread[] | undefined) {
  const key = seenKey(project, feature);
  const [seen, setSeen] = useState<SeenMap>();
  useEffect(() => {
    if (!threads || seen) return;
    const stored = readSeen(localStorage, key);
    const start = stored ?? baseline(threads);
    if (!stored) save(key, start);
    setSeen(start);
  }, [threads, seen, key]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      const next = readSeen(localStorage, key);
      if (next) setSeen(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  const markSeen = useCallback(
    (id: string, count: number) =>
      setSeen((prev) => {
        if (!prev || (prev[id] ?? 0) >= count) return prev;
        const next = { ...prev, [id]: count };
        save(key, next);
        return next;
      }),
    [key],
  );
  return { seen: seen ?? {}, ready: !!seen, markSeen };
}
