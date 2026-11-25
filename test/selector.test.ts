import { describe, expect, it } from "vitest";
import { selectorFor } from "../src/core/selector.ts";
import { selectorFor as canvasSelectorFor } from "../web/src/screen-doc.ts";

interface Fake {
  tagName: string;
  localName: string;
  id: string;
  parentElement: Fake | null;
  children: Fake[];
  getAttribute(name: string): string | null;
}
const mk = (tag: string, attrs: Record<string, string> = {}, parent?: Fake): Fake => {
  const el: Fake = { tagName: tag.toUpperCase(), localName: tag, id: attrs.id ?? "", parentElement: parent ?? null, children: [], getAttribute: (k) => attrs[k] ?? null };
  parent?.children.push(el);
  return el;
};

describe("the CLI's copy of selectorFor", () => {
  it("gives the canvas's selector for every element, so an agent's anchor is one the canvas finds", () => {
    const body = mk("body");
    const section = mk("section", { "data-screen": "A" }, body);
    const main = mk("main", {}, section);
    const all = [
      section,
      main,
      mk("h1", {}, main),
      mk("p", {}, main),
      mk("p", {}, main),
      mk("button", { "data-id": 'say "hi"' }, main),
      mk("input", { id: "email" }, main),
      mk("input", { id: "9bad" }, main),
    ];
    const deep = mk("span", {}, mk("li", {}, mk("ul", {}, all[6])));
    for (const el of [...all, deep]) expect(selectorFor(el, body)).toBe(canvasSelectorFor(el, body));
  });

  it("runs from its own source alone, as it does inside a rendered screen", () => {
    const standalone = new Function(`return (${selectorFor.toString()})`)() as typeof selectorFor;
    const body = mk("body");
    const b = mk("b", {}, mk("p", {}, body));
    expect(standalone(b, body)).toBe("p > b");
  });
});
