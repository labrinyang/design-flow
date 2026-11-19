import { useEffect, useRef, useState } from "react";
import type { Anchor, Thread } from "../../src/core/comments.ts";
import type { Flow, Issue } from "../../src/core/flow.ts";
import type { Layout, Overrides } from "../../src/core/layout.ts";

export interface ViewThread extends Thread {
  where: string;
  orphan: boolean;
}
export interface FeatureState {
  project: string;
  feature: string;
  flow?: Flow;
  layout?: Layout;
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
  del: <T = FeatureState>(path: string) => call<T>(path, { method: "DELETE" }),
  comment: (p: string, f: string, anchor: Anchor, text: string) => api.post(`${api.feature(p, f)}/comments`, { anchor, text }),
  thread: (p: string, f: string, id: string, op: "reply" | "resolve" | "reopen", body: unknown = {}) =>
    api.post(`${api.feature(p, f)}/threads/${id}/${op}`, body),
  saveLayout: (p: string, f: string, o: Overrides) => api.post(`${api.feature(p, f)}/layout`, o),
  clearLayout: (p: string, f: string) => api.del(`${api.feature(p, f)}/layout`),
  approve: (p: string, f: string, sha256: string) => api.post(`${api.feature(p, f)}/approve`, { sha256 }),
};

/** Live feature state over WebSocket, with reconnect. */
export function useFeature(project: string, feature: string) {
  const [state, setState] = useState<FeatureState>();
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string>();
  const retry = useRef<number>(undefined);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?project=${project}&feature=${feature}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "state") {
          setState(m.state);
          setError(undefined);
        } else if (m.type === "error") setError(m.message);
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
  }, [project, feature]);
  return { state, setState, connected, error };
}
