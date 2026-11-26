import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { layoutFlow } from "../src/core/layout.ts";
import { actualSizeZoom, chromeScale, FIT_MAX_ZOOM, fitViewport, MAX_ZOOM, MIN_ZOOM, openViewport, PIN_MIN_PX, PIN_PX, pinScale, wheelZoomStep, ZOOM_STEP, zoomAround } from "../web/src/zoom.ts";

describe("openViewport", () => {
  const canvas = { width: 1000, height: 800 };
  const insets = { top: 20, right: 20, bottom: 20, left: 20 };
  it("shows a board whole when it fits about as large as at the window's width", () => {
    const b = { x: 0, y: 0, width: 2000, height: 1000 };
    expect(openViewport(b, canvas, insets)).toEqual(fitViewport(b, canvas, insets));
  });
  it("opens a tall board at the window's width, from its top", () => {
    const b = { x: 40, y: 40, width: 4800, height: 30000 };
    const v = openViewport(b, canvas, insets);
    expect(v.zoom).toBeCloseTo(960 / 4800);
    expect(v.x).toBeCloseTo(20 - 40 * v.zoom);
    expect(v.y).toBeCloseTo(20 - 40 * v.zoom);
  });
  it("never opens a narrow tall board past 100%", () => {
    expect(openViewport({ x: 0, y: 0, width: 400, height: 30000 }, canvas, insets).zoom).toBe(1);
  });
});

describe("zoom limits", () => {
  it("zooms in further than fit to window goes", () => {
    expect(MAX_ZOOM).toBeGreaterThan(FIT_MAX_ZOOM);
  });
});

describe("chrome and pin scales", () => {
  it("lets outlines follow the zoom up to 100%, then keep their 100% size", () => {
    expect(chromeScale(0.4)).toBe(1);
    expect(chromeScale(1)).toBe(1);
    expect(chromeScale(4)).toBe(0.25);
    expect(MAX_ZOOM * chromeScale(MAX_ZOOM)).toBe(1);
  });

  it("keeps pins between 22px and 28px on screen", () => {
    const onScreen = (zoom: number) => PIN_PX * zoom * pinScale(zoom);
    expect(onScreen(0.1)).toBeCloseTo(PIN_MIN_PX);
    expect(onScreen(0.44)).toBeCloseTo(PIN_MIN_PX);
    expect(onScreen(0.9)).toBeCloseTo(PIN_PX * 0.9);
    expect(onScreen(1)).toBeCloseTo(PIN_PX);
    expect(onScreen(MAX_ZOOM)).toBeCloseTo(PIN_PX);
  });
});

describe("wheelZoomStep", () => {
  const max = Math.log2(ZOOM_STEP);
  it("zooms in for a wheel up and out for a wheel down", () => {
    expect(wheelZoomStep(-2, 0, true)).toBeGreaterThan(0);
    expect(wheelZoomStep(2, 0, true)).toBeLessThan(0);
  });
  it("follows small pinch and tick deltas as React Flow's pinch zoom does on macOS", () => {
    expect(wheelZoomStep(-4, 0, true)).toBeCloseTo(4 * 0.002 * 10);
    expect(wheelZoomStep(-100, 0, false)).toBeCloseTo(100 * 0.002);
  });
  it("never zooms more than one press of + in one event", () => {
    expect(wheelZoomStep(-100, 0, true)).toBeCloseTo(max);
    expect(wheelZoomStep(500, 0, true)).toBeCloseTo(-max);
    expect(wheelZoomStep(-3, 1, true)).toBeCloseTo(max);
  });
});

describe("zoomAround", () => {
  it("keeps the point under the pointer where it is", () => {
    const v = { x: 100, y: 50, zoom: 0.5 };
    const p = { x: 400, y: 300 };
    const n = zoomAround(v, p, 1);
    expect(n.zoom).toBe(1);
    // The flow point under p before and after is the same.
    expect((p.x - v.x) / v.zoom).toBeCloseTo((p.x - n.x) / n.zoom);
    expect((p.y - v.y) / v.zoom).toBeCloseTo((p.y - n.y) / n.zoom);
  });
  it("stops at the zoom limits", () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 7 }, { x: 0, y: 0 }, 2).zoom).toBe(MAX_ZOOM);
    expect(zoomAround({ x: 0, y: 0, zoom: 0.12 }, { x: 0, y: 0 }, -2).zoom).toBe(MIN_ZOOM);
  });
});

describe("fitViewport", () => {
  const canvas = { width: 1000, height: 800 };
  it("centres the bounds in what the insets leave free", () => {
    const v = fitViewport({ x: 0, y: 0, width: 2000, height: 1000 }, canvas, { top: 20, right: 20, bottom: 100, left: 20 });
    expect(v.zoom).toBeCloseTo(960 / 2000);
    // Bottom of the content sits above the toolbar's inset; left and right margins are equal.
    expect(v.y + 1000 * v.zoom).toBeLessThanOrEqual(800 - 100 + 0.001);
    expect(v.x).toBeCloseTo(20);
    expect(1000 - (v.x + 2000 * v.zoom)).toBeCloseTo(20);
  });
  it("does not blow a small flow up past the fit limit", () => {
    expect(fitViewport({ x: 0, y: 0, width: 100, height: 100 }, canvas, { top: 0, right: 0, bottom: 0, left: 0 }).zoom).toBe(FIT_MAX_ZOOM);
  });
});

describe("actualSizeZoom", () => {
  it("draws the screen nearest the middle at its real CSS size", async () => {
    const flow = parseFlow(
      `version: 1
title: T
viewport: { width: 390, height: 844 }
screens:
  - { id: A, title: Phone }
  - { id: B, title: Desktop, viewport: { width: 1280, height: 800 } }
edges:
  - { from: A, to: B }
`,
      "t",
    ).flow as Flow;
    const layout = await layoutFlow(flow);
    const a = layout.screens.A;
    const b = layout.screens.B;
    expect(actualSizeZoom(flow, layout, { x: a.x + a.w / 2, y: a.y + a.h / 2 })).toBeCloseTo(390 / a.w);
    expect(actualSizeZoom(flow, layout, { x: b.x + b.w / 2, y: b.y + b.h / 2 })).toBeCloseTo(1280 / b.w);
  });
});
