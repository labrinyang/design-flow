import { routeEdges, type RouteInput, type Routed } from "./route.ts";

export type Routes = (Routed | undefined)[];

const PREFIX = "design-flow:routes:";
const INDEX = "design-flow:routes";
/** Boards kept, the most recently used: one per layout and set of collapsed lanes. */
const KEEP = 24;

/**
 * Bump when route.ts draws lines differently, so routes kept from before are not used. A new build changes the
 * key anyway (the bundle's URL is in it); this covers the dev server, whose URLs stay the same.
 */
const VERSION = 1;

/** A 53-bit hash of a string (cyrb53), enough to tell routing problems apart. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** What the routes for this problem are kept under. */
export function routesKey(input: RouteInput): string {
  return hashText(`${VERSION}\n${import.meta.url}\n${JSON.stringify(input)}`);
}

/** The routes worked out for this problem before, kept in the browser. */
export function cachedRoutes(key: string): Routes | undefined {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v ? (JSON.parse(v) as Routes).map((r) => r ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string, routes: Routes) {
  try {
    const index = (JSON.parse(localStorage.getItem(INDEX) ?? "[]") as string[]).filter((k) => k !== key);
    index.push(key);
    while (index.length > KEEP) localStorage.removeItem(PREFIX + index.shift());
    localStorage.setItem(PREFIX + key, JSON.stringify(routes));
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch {
    /* storage full or blocked: they are worked out again next time */
  }
}

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (routes: Routes) => void>();

function routeInWorker(input: RouteInput): Promise<Routes> {
  if (typeof Worker === "undefined") return Promise.resolve(routeEdges(input));
  if (!worker) {
    worker = new Worker(new URL("./route-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; routes: Routes }>) => {
      waiting.get(e.data.id)?.(e.data.routes.map((r) => r ?? undefined));
      waiting.delete(e.data.id);
    };
  }
  const id = nextId++;
  return new Promise((done) => {
    waiting.set(id, done);
    worker!.postMessage({ id, input });
  });
}

/** Works the routes out off the main thread and keeps them for next time. */
export async function routeLater(key: string, input: RouteInput): Promise<Routes> {
  const routes = await routeInWorker(input);
  remember(key, routes);
  return routes;
}
