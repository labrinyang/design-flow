import { describe, expect, it } from "vitest";
import { LIVE_MAX, pickLive, type LiveBox } from "../web/src/live.ts";

const view = { width: 1000, height: 800 };
const at = (id: string, x: number, y: number, picture = true): LiveBox => ({ id, x, y, w: 180, h: 390, picture });

describe("which screens are live frames", () => {
  it("only those on screen and big enough to read, when they have a picture to show otherwise", () => {
    const boxes = [at("near", 0, 0), at("off", 5000, 0)];
    expect([...pickLive(boxes, { x: 0, y: 0, zoom: 1 }, view, new Set())]).toEqual(["near"]);
    // At 20% a phone frame is 36 × 78 px: its picture is enough.
    expect(pickLive(boxes, { x: 0, y: 0, zoom: 0.2 }, view, new Set()).size).toBe(0);
  });

  it("a screen with no picture yet while on screen at any size, after the big ones", () => {
    const boxes = [at("drawn", 0, 0), at("waiting", 400, 0, false)];
    expect([...pickLive(boxes, { x: 0, y: 0, zoom: 0.2 }, view, new Set())]).toEqual(["waiting"]);
  });

  it("no more than LIVE_MAX at once, the biggest and then the nearest the middle", () => {
    const boxes = Array.from({ length: 40 }, (_, i) => at(`s${i}`, (i % 10) * 200, Math.floor(i / 10) * 400));
    const live = pickLive(boxes, { x: 0, y: 0, zoom: 0.5 }, view, new Set());
    expect(live.size).toBe(LIVE_MAX);
    // All 90 × 195 px: the one nearest the middle of the view, whose middle is at (545, 497.5).
    expect([...pickLive(boxes, { x: 0, y: 0, zoom: 0.5 }, view, new Set(), new Set(), 1)]).toEqual(["s25"]);
  });

  it("keeps a live frame a little below the size it needed, and adds those that must be live", () => {
    // 160 × 100 px is the limit; at 0.43 this frame is 77.4 × 167.7 px = 12980 px², above 80% of it.
    const box = [at("a", 0, 0)];
    expect(pickLive(box, { x: 0, y: 0, zoom: 0.43 }, view, new Set()).size).toBe(0);
    expect(pickLive(box, { x: 0, y: 0, zoom: 0.43 }, view, new Set(["a"])).size).toBe(1);
    expect([...pickLive([at("tiny", 0, 0), at("gone", 9000, 0)], { x: 0, y: 0, zoom: 0.05 }, view, new Set(), new Set(["tiny", "nope"]))]).toEqual(["tiny"]);
  });
});
