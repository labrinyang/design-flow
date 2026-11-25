import type { Flow, Issue } from "./flow.ts";

/**
 * One interactive document for the whole flow: `<section data-screen="ID">` per screen, and
 * `data-to="ID"` on whatever moves the user to another screen. The canvas shows each section in
 * its own frame; Play runs the whole document so state carries from screen to screen.
 */
export interface Prototype {
  /** Everything inside <head>: styles and scripts shared by every screen. */
  head: string;
  screens: { id: string; html: string; line: number }[];
  jumps: { from: string; to: string; line: number }[];
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const SECTION = /<section\b[^>]*\bdata-screen\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
const JUMP = /\bdata-to\s*=\s*(["'])([^"']+)\1/gi;

/** The end of the element opened at `start`, counting nested <section>s. */
function closeOf(text: string, start: number): number {
  const tag = /<(\/?)section\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return text.length;
}

export function readPrototype(source: string): Prototype {
  // Blank out comments (keeping their newlines) so examples written in them are not read as screens.
  const text = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const h = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(text);
  const head = h ? source.slice(h.index, h.index + h[0].length).replace(/^<head\b[^>]*>/i, "").replace(/<\/head>$/i, "").trim() : "";
  const screens: Prototype["screens"] = [];
  const jumps: Prototype["jumps"] = [];
  SECTION.lastIndex = 0;
  for (let m = SECTION.exec(text); m; m = SECTION.exec(text)) {
    const end = closeOf(text, m.index);
    const html = source.slice(m.index, end);
    const id = m[2];
    screens.push({ id, html, line: lineAt(text, m.index) });
    JUMP.lastIndex = 0;
    for (let j = JUMP.exec(html); j; j = JUMP.exec(html)) jumps.push({ from: id, to: j[2], line: lineAt(text, m.index + j.index) });
    SECTION.lastIndex = end;
  }
  return { head, screens, jumps };
}

/** Problems between prototype.html and flow.yaml, as `check` prints them. */
export function checkPrototype(p: Prototype, flow: Flow, file: string): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(flow.screens.map((s) => s.id));
  const drawn = new Set(flow.edges.map((e) => `${e.from}>${e.to}`));
  const reported = new Set<string>();
  for (const j of p.jumps) {
    if (!ids.has(j.to))
      issues.push({ file, line: j.line, col: 1, message: `data-to in ${j.from} goes to unknown screen ${j.to}`, hint: `Use a screen id from flow.yaml: ${[...ids].join(", ")}.` });
    else if (!drawn.has(`${j.from}>${j.to}`) && !reported.has(`${j.from}>${j.to}`)) {
      reported.add(`${j.from}>${j.to}`);
      issues.push({ file, line: j.line, col: 1, message: `${j.from} → ${j.to} has no edge in flow.yaml`, hint: `Add { from: ${j.from}, to: ${j.to}, label: … } under edges, or remove the data-to.` });
    }
  }
  const sections = new Set(p.screens.map((s) => s.id));
  for (const s of p.screens)
    if (!ids.has(s.id))
      issues.push({ file, line: s.line, col: 1, message: `section ${s.id} is not a screen in flow.yaml`, hint: "Add the screen under screens, or rename the section." });
  for (const s of flow.screens)
    if (!sections.has(s.id) && s.html === undefined && s.file === undefined)
      issues.push({ file, line: 1, col: 1, message: `screen ${s.id} has no <section data-screen="${s.id}"> in prototype.html`, hint: "Add the section, or give the screen html: or file: in flow.yaml." });
  return issues;
}

/**
 * Give each screen without html/file its section from the prototype, with the line the section starts on, and the
 * prototype's <head> as shared style.
 */
export function applyPrototype(flow: Flow, p: Prototype): Flow {
  const byId = new Map(p.screens.map((s) => [s.id, s]));
  return {
    ...flow,
    style: [flow.style, p.head].filter(Boolean).join("\n") || undefined,
    screens: flow.screens.map((s) => {
      const section = byId.get(s.id);
      return s.html === undefined && s.file === undefined && section ? { ...s, html: section.html, htmlLine: section.line } : s;
    }),
  };
}
