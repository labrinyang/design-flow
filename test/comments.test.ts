import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommentStore, describeAnchor, isOrphan, seenCount, type Anchor } from "../src/core/comments.ts";
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

  it("keeps a user message unread until it is marked read, however often it is listed", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "first");
    expect(s.unread().map((m) => m.text)).toEqual(["first"]);
    expect(CommentStore.load(dir).unread().map((m) => m.text)).toEqual(["first"]);
    s.markRead([t.id]);
    expect(CommentStore.load(dir).unread()).toEqual([]);
    s.reply(t.id, "agent", "ok");
    s.reply(t.id, "user", "second");
    const reloaded = CommentStore.load(dir);
    expect(reloaded.unread().map((m) => [m.threadId, m.text, m.first])).toEqual([[t.id, "second", false]]);
    reloaded.markRead([t.id]);
    expect(CommentStore.load(dir).unread()).toEqual([]);
    expect(CommentStore.load(dir).threads[0].seen).toBe(3);
  });

  it("has nothing unread in a resolved thread, and the unread messages back when it reopens", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "first");
    s.resolve(t.id);
    expect(s.unread()).toEqual([]);
    s.reopen(t.id);
    expect(s.unread().map((m) => m.text)).toEqual(["first"]);
  });

  it("reads files from before read tracking: resolved threads as read, open ones up to the agent's last reply", () => {
    const dir = tmp();
    const m = (id: string, author: "user" | "agent", delivered = true) => ({ id, author, text: id, at: "2026-01-01T00:00:00.000Z", delivered });
    const threads = [
      { id: "aaaaaaaa", anchor: { type: "canvas", point: pt }, status: "open", createdAt: "x", messages: [m("u1", "user")] },
      { id: "bbbbbbbb", anchor: { type: "canvas", point: pt }, status: "open", createdAt: "x", messages: [m("u2", "user"), m("a2", "agent"), m("u3", "user")] },
      { id: "cccccccc", anchor: { type: "canvas", point: pt }, status: "resolved", createdAt: "x", messages: [m("u4", "user")] },
    ];
    writeFileSync(join(dir, "comments.json"), JSON.stringify({ version: 1, threads }));
    const s = CommentStore.load(dir);
    expect(s.threads.map(seenCount)).toEqual([0, 2, 1]);
    // delivered: true meant "sent to a watcher", which proves nothing was read.
    expect(s.unread().map((x) => x.text)).toEqual(["u1", "u3"]);
    s.markRead(["aaaaaaaa"]);
    const saved = JSON.parse(readFileSync(join(dir, "comments.json"), "utf8")).threads;
    expect(saved[0].seen).toBe(1);
    expect(saved.flatMap((t: { messages: object[] }) => t.messages).some((x: object) => "delivered" in x)).toBe(false);
    expect(CommentStore.load(dir).unread().map((x) => x.text)).toEqual(["u3"]);
  });

  it("stores an agent's options and the user's pick, which reads as the option it names", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "Where does Claim go?");
    s.markRead([t.id]);
    const offer = s.reply(t.id, "agent", "Two ways:", { options: ["One Claim for the LP", "A Claim per reward"], recommended: 0 });
    expect(CommentStore.load(dir).threads[0].messages[1]).toMatchObject({ options: ["One Claim for the LP", "A Claim per reward"], recommended: 0 });
    s.resolve(t.id);
    s.pick(t.id, offer.id, 1);
    const again = CommentStore.load(dir);
    expect(again.threads[0].status).toBe("open");
    expect(again.threads[0].messages[2]).toMatchObject({ author: "user", text: "A Claim per reward", pick: { message: offer.id, option: 1 } });
    expect(again.unread().map((x) => x.text)).toEqual(["picked B: A Claim per reward"]);
  });

  it("rejects bad offers and picks", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "x");
    expect(() => s.reply(t.id, "agent", "?", { options: ["only one"], recommended: 0 })).toThrow(RangeError);
    expect(() => s.reply(t.id, "agent", "?", { options: ["a", "b", "c", "d", "e"], recommended: 0 })).toThrow(RangeError);
    expect(() => s.reply(t.id, "agent", "?", { options: ["a", "b"], recommended: 2 })).toThrow(RangeError);
    expect(() => s.reply(t.id, "agent", "?", { options: ["a", "b"] })).toThrow(/recommend/);
    expect(() => s.reply(t.id, "user", "?", { options: ["a", "b"], recommended: 0 })).toThrow(RangeError);
    const plain = s.reply(t.id, "agent", "no options");
    expect(() => s.pick(t.id, plain.id, 0)).toThrow(RangeError);
    const offer = s.reply(t.id, "agent", "?", { options: ["a", "b"], applied: 1 });
    expect(() => s.pick(t.id, offer.id, 2)).toThrow(RangeError);
    expect(CommentStore.load(dir).threads[0].messages).toHaveLength(3);
  });

  it("resolves for the agent only once it has read the thread to the end", () => {
    const dir = tmp();
    const s = CommentStore.load(dir);
    const t = s.addThread({ type: "canvas", point: pt }, "first");
    expect(s.resolveIfRead(t.id).map((m) => m.text)).toEqual(["first"]);
    expect(CommentStore.load(dir).threads[0].status).toBe("open");
    s.markRead([t.id]);
    expect(s.resolveIfRead(t.id)).toEqual([]);
    expect(CommentStore.load(dir).threads[0].status).toBe("resolved");
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

  it("marks read only what the agent was shown: a message added after the load stays unread", () => {
    const dir = tmp();
    const t = CommentStore.load(dir).addThread({ type: "canvas", point: pt }, "shown");
    const shown = CommentStore.load(dir);
    CommentStore.load(dir).reply(t.id, "user", "arrived while printing");
    shown.markRead([t.id]);
    expect(CommentStore.load(dir).unread().map((d) => d.text)).toEqual(["arrived while printing"]);
  });

  it("never moves the read count back", () => {
    const dir = tmp();
    const t = CommentStore.load(dir).addThread({ type: "canvas", point: pt }, "a");
    const old = CommentStore.load(dir);
    const s = CommentStore.load(dir);
    s.reply(t.id, "user", "b");
    s.markRead([t.id]);
    old.markRead([t.id]);
    expect(CommentStore.load(dir).threads[0].seen).toBe(2);
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
