import { describe, expect, it } from "vitest";
import { parseFlow, type Flow } from "../src/core/flow.ts";
import { anchorFromFrame, anchorTitle, elementPhrase, pinOnElement } from "../web/src/anchor.ts";
import { formatLink, parseLink } from "../web/src/link.ts";
import { MOTION_MIN_AREA, shouldPlay } from "../web/src/motion.ts";
import { acceptFrameLocated, cleanElement, nearText } from "../web/src/screen-doc.ts";
import { baseline, firstNew, readSeen } from "../web/src/seen.ts";
import { exactTime, relativeTime } from "../web/src/time.ts";
import { focusZoom, labelScale, laneTitleScale } from "../web/src/zoom.ts";

describe("shouldPlay", () => {
  const view = { width: 1000, height: 800 };
  const phone = { x: 0, y: 0, w: 180, h: 390 };
  it("pauses frames that are too small to watch, by on-screen area", () => {
    expect(shouldPlay(phone, { x: 0, y: 0, zoom: 0.1 }, view, true)).toBe(false);
    expect(shouldPlay(phone, { x: 0, y: 0, zoom: 0.5 }, view, false)).toBe(180 * 390 * 0.25 >= MOTION_MIN_AREA);
    expect(shouldPlay(phone, { x: 0, y: 0, zoom: 1 }, view, false)).toBe(true);
  });
  it("pauses frames off screen", () => {
    expect(shouldPlay(phone, { x: -500, y: 0, zoom: 1 }, view, true)).toBe(false);
    expect(shouldPlay(phone, { x: 1000, y: 0, zoom: 1 }, view, true)).toBe(false);
    expect(shouldPlay(phone, { x: -170, y: 0, zoom: 1 }, view, false)).toBe(true);
  });
  it("keeps a playing frame playing a little below the limit, so it does not flip", () => {
    const zoom = Math.sqrt((MOTION_MIN_AREA * 0.9) / (180 * 390));
    expect(shouldPlay(phone, { x: 0, y: 0, zoom }, view, false)).toBe(false);
    expect(shouldPlay(phone, { x: 0, y: 0, zoom }, view, true)).toBe(true);
  });
});

describe("links", () => {
  it("reads a thread or a screen from the hash, the thread first", () => {
    expect(parseLink("#screen=P02")).toEqual({ screen: "P02" });
    expect(parseLink("#thread=ab12cd34")).toEqual({ thread: "ab12cd34" });
    expect(parseLink("#screen=P02&thread=ab12")).toEqual({ thread: "ab12" });
    expect(parseLink("")).toEqual({});
  });
  it("writes one target, or nothing", () => {
    expect(formatLink({ screen: "P02" })).toBe("#screen=P02");
    expect(formatLink({ thread: "x", screen: "P02" })).toBe("#thread=x");
    expect(formatLink({})).toBe("");
    expect(parseLink(formatLink({ screen: "a b&c" }))).toEqual({ screen: "a b&c" });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-24T15:00:00");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("says how long ago, in Chinese and English", () => {
    expect(relativeTime(ago(20_000), now, "zh")).toBe("刚刚");
    expect(relativeTime(ago(3 * 60_000), now, "zh")).toBe("3 分钟前");
    expect(relativeTime(ago(2 * 3600_000), now, "zh")).toBe("2 小时前");
    expect(relativeTime(ago(3 * 60_000), now, "en")).toBe("3 minutes ago");
    expect(relativeTime(ago(20_000), now, "en")).toBe("just now");
  });
  it("names yesterday, then days, then the date", () => {
    expect(relativeTime(new Date("2026-11-23T20:00:00").toISOString(), now, "zh")).toBe("昨天");
    expect(relativeTime(new Date("2026-11-21T12:00:00").toISOString(), now, "zh")).toBe("3 天前");
    expect(relativeTime(new Date("2026-10-02T12:00:00").toISOString(), now, "zh")).toBe("10月2日");
    expect(relativeTime("not a date", now, "zh")).toBe("");
  });
  it("gives the full time for the tooltip", () => {
    expect(exactTime(new Date("2026-11-24T09:05:00").toISOString(), "zh")).toContain("2026");
  });
});

describe("seen by the user", () => {
  const msgs = [{ author: "user" as const }, { author: "agent" as const }, { author: "user" as const }, { author: "agent" as const }];
  it("finds the first agent message not seen yet", () => {
    expect(firstNew(msgs, 0)).toBe(1);
    expect(firstNew(msgs, 2)).toBe(3);
    expect(firstNew(msgs, 4)).toBeUndefined();
    expect(firstNew(msgs, undefined)).toBe(1);
    expect(firstNew([{ author: "user" }], 0)).toBeUndefined();
  });
  it("starts a new browser with everything seen, and reads only numbers back", () => {
    expect(baseline([{ id: "a", messages: [1, 2] }, { id: "b", messages: [] }])).toEqual({ a: 2, b: 0 });
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readSeen(store('{"a":2,"b":"x"}'), "k")).toEqual({ a: 2 });
    expect(readSeen(store("[1]"), "k")).toBeUndefined();
    expect(readSeen(store("{oops"), "k")).toBeUndefined();
    expect(readSeen(store(null), "k")).toBeUndefined();
  });
});

const flow = parseFlow(
  `version: 1
title: T
lanes:
  - { id: pay, title: Checkout }
screens:
  - { id: P01, title: Cart, lane: pay }
  - { id: P02, title: Pay, lane: pay }
edges:
  - { from: P01, to: P02, label: Continue }
`,
  "t",
).flow as Flow;

describe("anchor titles", () => {
  it("names the screen and the element in plain words, ids in the tip", () => {
    const t = anchorTitle({ type: "element", screen: "P02", selector: "main > button", tag: "button", text: "Pay now", point: { x: 0, y: 0 } }, flow, "zh");
    expect(t).toEqual({ title: "Pay", detail: "按钮“Pay now”", tip: "帧 P02，main > button" });
    expect(anchorTitle({ type: "screen", screen: "P01", point: { x: 0, y: 0 } }, flow, "en")).toEqual({ title: "Cart", tip: "Screen P01" });
    expect(anchorTitle({ type: "edge", edge: { from: "P01", to: "P02" }, point: { x: 0, y: 0 } }, flow, "en").title).toBe("Cart → Pay");
    expect(anchorTitle({ type: "lane", lane: "pay", point: { x: 0, y: 0 } }, flow, "zh").title).toBe("Checkout");
    expect(anchorTitle({ type: "screen", screen: "P09", point: { x: 0, y: 0 } }, flow, "zh").title).toBe("P09（已删除）");
  });
  it("says what kind of element it is when the tag says so", () => {
    expect(elementPhrase("a", "Terms", "en")).toBe('Link "Terms"');
    expect(elementPhrase("div", "$12.00", "zh")).toBe("“$12.00”");
    expect(elementPhrase("img", "", "zh")).toBe("图片");
    expect(elementPhrase("div", "", "en")).toBe("Element");
    expect(elementPhrase("p", "a very long piece of text that goes on and on", "en")).toBe('"a very long piece of te…"');
  });
});

describe("element anchors", () => {
  const click = {
    screen: "P02",
    x: 50,
    y: 100,
    element: { selector: "#pay", tag: "button", text: "Pay", box: { x: 20, y: 80, width: 100, height: 40 }, offset: { x: 0.3, y: 0.5 }, near: "Total $12 Pay", line: 42 },
  };
  it("keep the box, the click spot, the text around and the line", () => {
    const a = anchorFromFrame(click, { x: 1000, y: 2000, w: 195 }, 390, 100);
    expect(a).toMatchObject({ type: "element", point: { x: 1025, y: 2050 }, box: click.element.box, offset: { x: 0.3, y: 0.5 }, near: "Total $12 Pay", line: 141 });
    // A screen whose html is not a prototype section has no line to give.
    expect(anchorFromFrame(click, { x: 1000, y: 2000, w: 195 }, 390)).not.toHaveProperty("line");
  });
  it("put the pin on the same spot of the element wherever it is now, inside the frame", () => {
    const a = anchorFromFrame(click, { x: 1000, y: 2000, w: 195 }, 390);
    if (a.type !== "element") throw new Error("element anchor expected");
    const frame = { x: 1000, y: 2000, w: 195, h: 422 };
    expect(pinOnElement(a, { x: 20, y: 300, width: 100, height: 40 }, frame, 390)).toEqual({ x: 1000 + Math.round(50 * 0.5) - 0, y: 2000 + 160 });
    expect(pinOnElement(a, { x: 20, y: 5000, width: 100, height: 40 }, frame, 390).y).toBe(2000 + 422);
  });
  it("without a click spot, use where the stored point falls in the element", () => {
    const old = { type: "element" as const, screen: "P02", selector: "#pay", tag: "button", text: "Pay", point: { x: 1025, y: 2050 } };
    expect(pinOnElement(old, { x: 20, y: 80, width: 100, height: 40 }, { x: 1000, y: 2000, w: 195, h: 422 }, 390)).toEqual({ x: 1025, y: 2050 });
  });
});

describe("frame reports", () => {
  it("keep only well-formed element fields", () => {
    expect(cleanElement({ selector: "a", tag: "a", text: "x", box: { x: 1, y: 2, width: 3, height: 4 }, offset: { x: 2, y: 0 }, near: 5, line: 1.5 })).toEqual({
      selector: "a",
      tag: "a",
      text: "x",
      box: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(cleanElement({ selector: 1 })).toBeNull();
    expect(cleanElement(null)).toBeNull();
  });
  it("accept located boxes only from the frame's own window", () => {
    const win = {} as unknown as MessageEventSource;
    const frames = new Map([["c1", { screen: "P02", window: () => win }]]);
    const data = { channel: "c1", type: "located", items: [{ id: "t1", x: 1, y: 2, width: 3, height: 4 }, { id: "t2", missing: true }, { id: "t3", x: "no" }] };
    expect(acceptFrameLocated({ data, source: win }, frames)).toEqual({
      screen: "P02",
      items: [
        { id: "t1", x: 1, y: 2, width: 3, height: 4 },
        { id: "t2", missing: true },
      ],
    });
    expect(acceptFrameLocated({ data, source: {} as MessageEventSource }, frames)).toBeUndefined();
  });
  it("finds the text around an element from its own source alone", () => {
    const standalone = new Function(`return (${nearText.toString()})`)() as typeof nearText;
    const card: any = { innerText: "Total  $12\n Pay now", parentElement: null };
    const btn: any = { innerText: "Pay now", parentElement: card };
    expect(standalone(btn, 120)).toBe("Total $12 Pay now");
    expect(standalone(btn, 8)).toBe("Total $…");
    expect(standalone({ innerText: "x", parentElement: null } as any, 120)).toBe("");
  });
});

describe("zoom helpers", () => {
  it("keep labels at their 100% size on screen when zoomed out", () => {
    expect(labelScale(0.25)).toBe(4);
    expect(labelScale(2)).toBe(1);
    expect(laneTitleScale(0.1) * 18 * 0.1).toBeCloseTo(14);
    expect(laneTitleScale(1)).toBe(1);
  });
  it("show one frame whole, no bigger than its real size", () => {
    expect(focusZoom({ w: 180, h: 436 }, { width: 1200, height: 800 }, 2.17)).toBeCloseTo((800 * 0.8) / 436);
    expect(focusZoom({ w: 180, h: 100 }, { width: 4000, height: 4000 }, 2.17)).toBe(2.17);
  });
});
