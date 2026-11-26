import { routeEdges, type RouteInput } from "./route.ts";

/** Routes a board's lines off the main thread: the canvas posts { id, input } and hears { id, routes }. */
self.onmessage = (e: MessageEvent<{ id: number; input: RouteInput }>) => {
  (self as unknown as { postMessage(m: unknown): void }).postMessage({ id: e.data.id, routes: routeEdges(e.data.input) });
};
