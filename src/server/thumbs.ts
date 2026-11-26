import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Flow, Screen, Viewport } from "../core/flow.ts";
import type { Layout } from "../core/layout.ts";
import { launchBrowser, screenPage, viewportOf, type Browser } from "../cli/render.ts";

/**
 * Pictures of screens for the canvas, which shows a picture instead of a live frame wherever a screen is too small
 * to read or work in. Each is drawn once by a headless browser and kept on disk under a hash of what it shows, so
 * an edit redraws only the screens it changed, and a canvas opened later finds them ready.
 */

/** Bump when pictures are drawn differently, so none drawn the old way are used. */
const VERSION = "1";
/** Picture pixels per canvas pixel of the frame: sharp on a 2x display up to 100% zoom. */
const DENSITY = 2;
const QUALITY = 82;
/** Pages drawn at once. */
const PARALLEL = 2;
/** Pictures not shown for this long are deleted when the server starts. */
const KEEP_MS = 30 * 24 * 3600 * 1000;
/** After the browser fails to start, wait this long before trying again. */
const RETRY_MS = 5 * 60 * 1000;

/** Draws a page to a JPEG. */
export interface PictureSource {
  draw(html: string, viewport: Viewport, scale: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** A headless Chrome (or Chromium, Edge, Brave), started on first use and closed after `idleMs` with nothing to draw. */
export function chromePictures(idleMs = 30_000): PictureSource {
  let browser: Promise<Browser> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let busy = 0;
  const closeSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy) return;
      const b = browser;
      browser = undefined;
      void b?.then((x) => x.close()).catch(() => {});
    }, idleMs);
    timer.unref();
  };
  return {
    async draw(html, viewport, scale) {
      busy++;
      clearTimeout(timer);
      try {
        browser ??= launchBrowser();
        const b = await browser.catch((e: unknown) => {
          browser = undefined;
          throw Object.assign(e as Error, { launch: true });
        });
        const page = await b.open(html, viewport, scale);
        try {
          return await page.screenshot(undefined, { format: "jpeg", quality: QUALITY });
        } finally {
          await page.close();
        }
      } finally {
        busy--;
        if (!busy) closeSoon();
      }
    },
    async close() {
      clearTimeout(timer);
      const b = browser;
      browser = undefined;
      await (await b?.catch(() => undefined))?.close();
    },
  };
}

interface Job {
  key: string;
  viewport: Viewport;
  scale: number;
  /** The page to draw, built only once the picture is queued. */
  page: () => string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** What a screen's picture shows, and so its name: the screen's own markup without line marks, which move when lines above it do. */
export function pictureJob(flow: Flow, screen: Screen, frameWidth: number, styleKey: string): Job {
  const viewport = viewportOf(flow, screen);
  const width = Math.max(1, Math.round(Math.min(viewport.width * DENSITY, frameWidth * DENSITY)));
  const key = sha([VERSION, viewport.width, viewport.height, width, styleKey, screen.html?.trim() ? screen.html : `empty:${screen.id}`].join("\0")).slice(0, 40);
  return { key, viewport, scale: width / viewport.width, page: () => screenPage(flow, { ...screen, htmlLine: undefined }) };
}

export const PICTURE_PATH = /^\/thumbs\/([0-9a-f]{40})\.jpg$/;

export class Pictures {
  private readonly queue = new Map<string, Job>();
  private readonly waiting = new Map<string, Set<string>>();
  private readonly failed = new Set<string>();
  private readonly drawing = new Set<string>();
  private running = 0;
  private brokenAt = 0;

  /** `onReady` hears each picture once it is on disk, with the tokens that asked for it. */
  constructor(
    private readonly dir: string,
    private readonly source: PictureSource,
    private readonly onReady: (key: string, url: string, tokens: Set<string>) => void,
    private readonly onError: (e: Error) => void = () => {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.prune();
  }

  file(key: string): string {
    return join(this.dir, `${key}.jpg`);
  }

  static url(key: string): string {
    return `/thumbs/${key}.jpg`;
  }

  /** Pictures are being drawn: there is a browser to draw them with, as far as anyone knows. */
  get available(): boolean {
    return !this.brokenAt || Date.now() - this.brokenAt >= RETRY_MS;
  }

  /**
   * Picture URLs for the flow's screens that are drawn already, by screen id; the others are queued, and `token`
   * plus the screen id goes to onReady when each is drawn.
   */
  forFlow(flow: Flow, layout: Layout, token: string): Record<string, string> {
    const out: Record<string, string> = {};
    const styleKey = sha(flow.style ?? "");
    for (const s of flow.screens) {
      const box = layout.screens[s.id];
      if (!box) continue;
      const job = pictureJob(flow, s, box.w, styleKey);
      if (existsSync(this.file(job.key))) out[s.id] = Pictures.url(job.key);
      else this.want(job, `${token}/${s.id}`);
    }
    return out;
  }

  private want(job: Job, token: string) {
    if (this.failed.has(job.key)) return;
    const tokens = this.waiting.get(job.key) ?? new Set();
    tokens.add(token);
    this.waiting.set(job.key, tokens);
    if (!this.queue.has(job.key) && !this.drawing.has(job.key)) this.queue.set(job.key, job);
    this.pump();
  }

  private pump() {
    if (Date.now() - this.brokenAt < RETRY_MS) return;
    while (this.running < PARALLEL && this.queue.size) {
      const [key, job] = this.queue.entries().next().value as [string, Job];
      this.queue.delete(key);
      this.running++;
      void this.draw(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async draw(job: Job) {
    this.drawing.add(job.key);
    try {
      const jpg = await this.source.draw(job.page(), job.viewport, job.scale);
      const file = this.file(job.key);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, jpg);
      renameSync(tmp, file);
      const tokens = this.waiting.get(job.key) ?? new Set<string>();
      this.waiting.delete(job.key);
      this.onReady(job.key, Pictures.url(job.key), tokens);
    } catch (e) {
      const err = e as Error & { launch?: boolean };
      if (err.launch) {
        // No browser to draw with: stop until later, and keep what was asked for.
        this.brokenAt = Date.now();
        this.queue.set(job.key, job);
      } else {
        this.failed.add(job.key);
        this.waiting.delete(job.key);
      }
      this.onError(err);
    } finally {
      this.drawing.delete(job.key);
    }
  }

  /** Deletes pictures nobody has looked at for a month. */
  private prune() {
    const now = Date.now();
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name);
      try {
        if (name.endsWith(".tmp") || now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true });
      } catch {
        /* gone already */
      }
    }
  }

  async close() {
    this.queue.clear();
    await this.source.close();
  }
}
