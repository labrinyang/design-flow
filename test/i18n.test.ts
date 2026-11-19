import { describe, expect, it } from "vitest";
import { pickLocale } from "../web/src/i18n.ts";

describe("pickLocale", () => {
  it("follows the browser language", () => {
    expect(pickLocale("zh-CN", "")).toBe("zh");
    expect(pickLocale("en-US", "")).toBe("en");
  });
  it("lets ?lang= override it", () => {
    expect(pickLocale("zh-CN", "?lang=en")).toBe("en");
    expect(pickLocale("en-US", "?x=1&lang=zh")).toBe("zh");
    expect(pickLocale("en-US", "?lang=fr")).toBe("en");
  });
});
