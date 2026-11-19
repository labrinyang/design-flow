import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommentStore, describeAnchor, isOrphan, type Anchor } from "../src/core/comments.ts";
import { parseFlow, type Flow } from "../src/core/flow.ts";

const flow = parseFlow(
  `version: 1
title: T
lanes:
  - { id: err, title: Errors }
screens:
  - id: P01
    title: Amount
    html: <input placeholder="Amount"><button>Next</button>
  - id: P02
    title: Choose payment
    html: <h1>Pay with</h1><button data-id="card">Bank card</button>
edges:
  - { from: P01, to: P02, label: Charge }
`,
  "t",
).flow as Flow;

const pt = { x: 10, y: 20 };
const tmp = () => mkdtempSync(join(tmpdir(), "df-comments-"));

describe("describeAnchor", () => {
  it("names an element inside a screen by its tag and text", () => {
    const a: Anchor = { type: "element", screen: "P02", selector: '[data-id="card"]', tag: "button", text: "Bank card", point: pt };
    expect(describeAnchor(a, flow, "en")).toBe('Screen P02 Choose payment · button "Bank card" ([data-id="card"])');
    expect(describeAnchor({ ...a, text: "" }, flow, "zh")).toBe('帧 P02 Choose payment · button（[data-id="card"]）');
  });

  it("names screens, edges, lanes and the canvas", () => {
    expect(describeAnchor({ type: "screen", screen: "P01", point: pt }, flow, "en")).toBe("Screen P01 Amount");
    expect(describeAnchor({ type: "edge", edge: { from: "P01", to: "P02" }, point: pt }, flow, "en")).toBe(
      'Edge P01 → P02 "Charge"',
    );
    expect(describeAnchor({ type: "lane", lane: "err", point: pt }, flow, "zh")).toBe("泳道“Errors”");
    expect(describeAnchor({ type: "canvas", point: pt, near: "P02" }, flow, "en")).toBe("Canvas, near P02");
  });

  it("marks anchors whose target is gone", () => {
    const a: Anchor = { type: "screen", screen: "P09", point: pt };
    expect(isOrphan(a, flow)).toBe(true);
    expect(describeAnchor(a, flow, "en")).toBe("Screen P09 (removed)");
    expect(isOrphan({ type: "element", screen: "P09", selector: "button", tag: "button", text: "", point: pt }, flow)).toBe(true);
    expect(isOrphan({ type: "element", screen: "P02", selector: "button", tag: "button", text: "", point: pt }, flow)).toBe(false);
    expect(isOrphan({ type: "edge", edge: { from: "P02", to: "P01" }, point: pt }, flow)).toBe(true);
    expect(isOrphan({ type: "canvas", point: pt }, flow)).toBe(false);
  });
});

describe("CommentStore", () => {
  it("persists threads, replies and resolution", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "screen", screen: "P01", point: pt }, "Missing back button");
    s.reply(t.id, "agent", "Added one");
    s.resolve(t.id);
    const again = CommentStore.load(dir);
    expect(again.threads).toHaveLength(1);
    expect(again.threads[0]).toMatchObject({ status: "resolved" });
    expect(again.threads[0].messages.map((m) => m.author)).toEqual(["user", "agent"]);
    expect(JSON.parse(readFileSync(join(dir, "comments.json"), "utf8")).threads).toHaveLength(1);
    again.reopen(t.id);
    expect(again.threads[0].status).toBe("open");
  });

  it("delivers each user message to the agent exactly once", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "first");
    s.reply(t.id, "agent", "ok");
    expect(s.takeUndelivered().map((m) => m.text)).toEqual(["first"]);
    expect(s.takeUndelivered()).toEqual([]);
    s.reply(t.id, "user", "second");
    const reloaded = CommentStore.load(dir);
    expect(reloaded.takeUndelivered().map((m) => [m.threadId, m.text])).toEqual([[t.id, "second"]]);
    expect(CommentStore.load(dir).takeUndelivered()).toEqual([]);
  });

  it("rejects unknown thread ids", () => {
    const s = CommentStore.load(tmp());
    expect(() => s.reply("nope", "agent", "x")).toThrow(/nope/);
  });
});

describe("CommentStore concurrency", () => {
  it("does not lose a write made by another store instance in between", () => {
    const dir = tmp();
    const a = CommentStore.load(dir);
    const t = a.addThread({ type: "canvas", point: pt }, "first");
    const stale = CommentStore.load(dir);
    const fresh = CommentStore.load(dir);
    fresh.reply(t.id, "user", "second");
    stale.resolve(t.id);
    const final = CommentStore.load(dir).threads[0];
    expect(final.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(final.status).toBe("resolved");
  });

  it("does not deliver a message twice when two stale instances take", () => {
    const dir = tmp();
    CommentStore.load(dir).addThread({ type: "canvas", point: pt }, "once");
    const x = CommentStore.load(dir);
    const y = CommentStore.load(dir);
    expect([...x.takeUndelivered(), ...y.takeUndelivered()].map((d) => d.text)).toEqual(["once"]);
  });
});

describe("edge anchors with parallel edges", () => {
  it("names the edge by its index when two edges share endpoints", () => {
    const twin = parseFlow(
      "version: 1\ntitle: T\nscreens: [{ id: A, title: A }, { id: B, title: B }]\nedges:\n  - { from: A, to: B, label: Retry }\n  - { from: A, to: B, label: Skip }\n",
      "t",
    ).flow as Flow;
    const a: Anchor = { type: "edge", edge: { from: "A", to: "B", index: 1 }, point: pt };
    expect(describeAnchor(a, twin, "en")).toBe('Edge A → B "Skip"');
    expect(isOrphan({ type: "edge", edge: { from: "A", to: "B", index: 5 }, point: pt }, twin)).toBe(false);
  });
});
