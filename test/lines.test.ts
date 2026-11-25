import { describe, expect, it } from "vitest";
import { annotateLines } from "../src/core/lines.ts";

/** The text with the marks taken out again, to check every other byte stayed. */
const unmark = (html: string) => html.replace(/ data-df-line="\d+"/g, "");
/** Each marked tag name with its line. */
const marks = (html: string) => [...html.matchAll(/<([^\s/>]+) data-df-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

describe("annotateLines", () => {
  it("marks each start tag with the line it starts on, counting from the first line", () => {
    const html = '<section data-screen="A">\n  <h1>Hi</h1>\n  <p>One <b>two</b></p>\n</section>';
    const out = annotateLines(html, 40);
    expect(marks(out)).toEqual(["section:40", "h1:41", "p:42", "b:42"]);
    expect(out).toContain('<section data-df-line="40" data-screen="A">');
    expect(unmark(out)).toBe(html);
  });

  it("is not fooled by > and quotes inside attribute values", () => {
    const html = `<button title="a > b" data-x='say "hi" >' onclick="if (a>b) go()">Go</button><i>next</i>`;
    const out = annotateLines(html, 1);
    expect(marks(out)).toEqual(["button:1", "i:1"]);
    expect(unmark(out)).toBe(html);
  });

  it("uses the line where a tag starts when the tag spans lines", () => {
    const html = '<input\n  type="text"\n  placeholder="a\nb">\n<b>z</b>';
    expect(marks(annotateLines(html, 5))).toEqual(["input:5", "b:9"]);
  });

  it("leaves tags inside comments alone but counts their lines, short comments included", () => {
    const html = "<!-- <div>\n<p>old</p> -->\n<p>new</p><!--><i>a</i><!---><i>b</i><!-- x --!><i>c</i>";
    const out = annotateLines(html, 1);
    expect(marks(out)).toEqual(["p:3", "i:3", "i:3", "i:3"]);
    expect(unmark(out)).toBe(html);
  });

  it("leaves the raw text of script, style, textarea and title alone", () => {
    const html = [
      '<script>if (a < b) el.innerHTML = "<p>x</p>";\nlet s = "<div>";</script>',
      "<style>a > b { color: red } /* <div> */</style>",
      "<textarea><b>not bold</b></textarea>",
      "<TITLE>A <i>title</i></TITLE>",
      "<p>after</p>",
    ].join("\n");
    const out = annotateLines(html, 1);
    expect(marks(out)).toEqual(["script:1", "style:3", "textarea:4", "TITLE:5", "p:6"]);
    expect(unmark(out)).toBe(html);
  });

  it("ends raw text where the parser does: at its end tag in any case, even inside a string", () => {
    const out = annotateLines('<script>var s = "</SCRIPT >";</script><em>e</em>', 1);
    expect(marks(out)).toEqual(["script:1", "em:1"]);
  });

  it("skips the doctype, end tags and a < that starts no tag", () => {
    const html = "<!doctype html>\n<p>a < b, 1 <2 and </p><br/><a href=/x/y>link</a>";
    const out = annotateLines(html, 1);
    expect(marks(out)).toEqual(["p:2", "br:2", "a:2"]);
    expect(out).toContain('<br data-df-line="2"/>');
    expect(out).toContain('<a data-df-line="2" href=/x/y>');
    expect(unmark(out)).toBe(html);
  });

  it("leaves a tag the text cuts off unmarked, and takes another attribute name", () => {
    expect(annotateLines('<p>ok</p><p class="cut', 1)).toBe('<p data-df-line="1">ok</p><p class="cut');
    expect(annotateLines("<p>x</p>", 3, "data-line")).toBe('<p data-line="3">x</p>');
  });
});
