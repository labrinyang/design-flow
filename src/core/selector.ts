// A copy of selectorFor in web/src/screen-doc.ts, which the CLI cannot import: tsc would compile it into dist/web,
// which vite empties when it builds the canvas. test/selector.test.ts checks that the two give the same selectors.

export interface ElementLike {
  tagName: string;
  localName: string;
  id: string;
  parentElement: ElementLike | null;
  children: ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
}

/**
 * A stable CSS selector for `el` from the document body: data-id, then id, then an nth-of-type path.
 * Self-contained: a rendered screen runs it from its own source, where no outer helper exists.
 */
export function selectorFor(el: ElementLike, body: ElementLike): string {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  const parts: string[] = [];
  let cur: ElementLike | null = el;
  while (cur && cur !== body) {
    const dataId = cur.getAttribute("data-id");
    if (dataId) {
      parts.unshift(`[data-id="${esc(dataId)}"]`);
      break;
    }
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    const parent: ElementLike | null = cur.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
    parts.unshift(siblings.length > 1 ? `${cur.localName}:nth-of-type(${siblings.indexOf(cur) + 1})` : cur.localName);
    cur = parent;
  }
  return parts.join(" > ");
}
