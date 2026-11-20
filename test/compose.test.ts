import { describe, expect, it } from "vitest";
import { sendsOnKey } from "../web/src/compose.ts";

const key = (k: Partial<{ key: string; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number }>) => ({
  key: "Enter",
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  ...k,
});

describe("sendsOnKey", () => {
  it("sends on a plain Enter", () => {
    expect(sendsOnKey(key({}))).toBe(true);
  });
  it("starts a new line on Shift+Enter or Option+Enter", () => {
    expect(sendsOnKey(key({ shiftKey: true }))).toBe(false);
    expect(sendsOnKey(key({ altKey: true }))).toBe(false);
  });
  it("leaves Enter to the input method while it is composing (pinyin, kana)", () => {
    expect(sendsOnKey(key({ isComposing: true }))).toBe(false);
    // Safari reports the confirming Enter of a composition as keyCode 229.
    expect(sendsOnKey(key({ keyCode: 229 }))).toBe(false);
  });
  it("ignores other keys", () => {
    expect(sendsOnKey(key({ key: "a", keyCode: 65 }))).toBe(false);
  });
});
