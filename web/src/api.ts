import { useCallback, useEffect, useRef, useState } from "react";
import type { Anchor, Thread } from "../../src/core/comments.ts";
import type { Flow, Issue } from "../../src/core/flow.ts";
import type { Layout } from "../../src/core/layout.ts";

export interface ViewThread extends Thread {
  where: string;
  orphan: boolean;
  /** How many messages, from the first, the agent has read. */
  seen: number;
}
export interface FeatureState {
  project: string;
  feature: string;
  flow?: Flow;
  layout?: Layout;
  /** Pictures of screens drawn so far, by screen id (URLs on this server); more arrive as they are drawn. */
  thumbs: Record<string, string>;
  /** Whether the server draws pictures at all (it needs Chrome); without them every screen is a live page. */
  pictures: boolean;
  issues: Issue[];
  sha256: string;
  threads: ViewThread[];
  status: { status: "draft" | "approved" | "stale"; openThreads: number; approvedAt?: string };
}
export interface ProjectSummary {
  key: string;
  dir: string;
  features: { name: string; status: FeatureState["status"]["status"]; openThreads: number }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  projects: () => call<ProjectSummary[]>("/api/projects"),
  feature: (p: string, f: string) => `/api/projects/${p}/features/${f}`,
  post: <T = FeatureState>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) }),
  comment: (p: string, f: string, anchor: Anchor, text: string) => api.post(`${api.feature(p, f)}/comments`, { anchor, text }),
  thread: (p: string, f: string, id: string, op: "reply" | "pick" | "resolve" | "reopen", body: unknown = {}) =>
    api.post(`${api.feature(p, f)}/threads/${id}/${op}`, body),
  /** prototype.html as written, for Play; null when the feature has none. */
  prototype: (p: string, f: string) => call<{ prototype: string | null }>(`${api.feature(p, f)}/prototype`),
  share: (p: string, f: string) => api.post<{ gist: string; url: string }>(`${api.feature(p, f)}/share`),
  approve: (p: string, f: string, sha256: string) => api.post(`${api.feature(p, f)}/approve`, { sha256 }),
};

/** Live feature state over WebSocket, with reconnect. */
export function useFeature(project: string, feature: string) {
  const [state, setStateOnly] = useState<FeatureState>();
  /**
   * Pictures of screens by screen id, as they are drawn. A screen keeps its last picture while the one of its new
   * version is being drawn, so it never goes blank on an edit.
   */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [pictures, setPictures] = useState(true);
  const setState = useCallback((s: FeatureState) => {
    setStateOnly(s);
    setThumbs((had) => ({ ...had, ...s.thumbs }));
    setPictures(s.pictures !== false);
  }, []);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string>();
  const retry = useRef<number>(undefined);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    setThumbs({});
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?project=${project}&feature=${feature}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "state") {
          setState(m.state);
          setError(undefined);
        } else if (m.type === "thumbs") setThumbs((had) => ({ ...had, ...m.thumbs }));
        else if (m.type === "pictures") setPictures(m.on);
        else if (m.type === "error") setError(m.message);
      };
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        retry.current = window.setTimeout(open, 1500);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(retry.current);
      ws?.close();
    };
  }, [project, feature, setState]);
  return { state, setState, thumbs, pictures, connected, error };
}
