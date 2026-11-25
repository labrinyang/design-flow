const TAG_NAME = /[^\s/>]+/y;
/** Elements whose content the HTML parser reads as text, not tags. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);

/**
 * Marks every element start tag in `html` with the line it starts on, so a rendered element can say where
 * it is written: `<button class="go">` on line 12 becomes `<button data-df-line="12" class="go">`. Comments,
 * the doctype, end tags and the raw text of script, style, textarea, title and the like are left alone, and
 * every other byte stays as it was. `firstLine` is the line `html` itself starts on.
 * Pure string work with no Node or DOM APIs, so the canvas can use it too.
 */
export function annotateLines(html: string, firstLine: number, attr = "data-df-line"): string {
  const out: string[] = [];
  let line = firstLine;
  let from = 0;
  let i = 0;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (html.charCodeAt(k) === 10) line++;
    i = to;
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    advance(lt);
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      advance(commentEnd(html, lt));
    } else if (next === "!" || next === "?") {
      advance(html.startsWith("<![CDATA[", lt) ? endOf(html, "]]>", lt) : endOf(html, ">", lt));
    } else if (next === "/") {
      advance(/[A-Za-z]/.test(html[lt + 2] ?? "") ? tagEnd(html, lt + 2) : endOf(html, ">", lt));
    } else if (/[A-Za-z]/.test(next)) {
      TAG_NAME.lastIndex = lt + 1;
      const name = TAG_NAME.exec(html)![0];
      const end = tagEnd(html, lt + 1 + name.length);
      if (html[end - 1] !== ">") break; // a tag cut off by the end of the text is not an element
      out.push(html.slice(from, lt + 1 + name.length), ` ${attr}="${line}"`);
      from = lt + 1 + name.length;
      advance(end);
      const raw = name.toLowerCase();
      if (raw === "plaintext") break;
      if (RAW_TEXT.has(raw)) advance(rawTextEnd(html, end, raw));
    } else {
      advance(lt + 1);
    }
  }
  out.push(html.slice(from));
  return out.join("");
}

/** Just past `token` from `from`, or the end of the text. */
const endOf = (html: string, token: string, from: number) => {
  const at = html.indexOf(token, from + 1);
  return at < 0 ? html.length : at + token.length;
};

/** Just past a comment that opens at `at`, including the short `<!-->` and `<!--->`, and `--!>`. */
function commentEnd(html: string, at: number): number {
  const body = at + 4;
  if (html[body] === ">") return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const re = /--!?>/g;
  re.lastIndex = body;
  const m = re.exec(html);
  return m ? m.index + m[0].length : html.length;
}

/** Just past the `>` that ends a tag, from just after its name; a `>` inside a quoted attribute value does not count. */
function tagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const c = html[i];
    if (c === ">") return i + 1;
    if (c === "=") {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        i = close < 0 ? html.length : close + 1;
        continue;
      }
      // An unquoted value runs to whitespace or the end of the tag.
      while (i < html.length && !/[\s>]/.test(html[i])) i++;
      continue;
    }
    i++;
  }
  return html.length;
}

/** Where the raw text of `name` that starts at `from` ends: at its end tag, or the end of the text. */
function rawTextEnd(html: string, from: number, name: string): number {
  const re = new RegExp(`</${name}(?=[\\s/>])`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : html.length;
}
