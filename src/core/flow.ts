import { Ajv2020 } from "ajv/dist/2020.js";
import { isMap, isSeq, LineCounter, parseDocument, type Document, type Node } from "yaml";
import schema from "../../schema/flow.v1.json" with { type: "json" };

export type Tone = "success" | "info" | "danger" | "neutral";
export type Badge = "home" | "video" | "timer";
export type EdgeKind = "normal" | "error" | "back";

export interface Lane {
  id: string;
  title: string;
  tone: Tone;
  note?: string;
  enter?: "any";
}
export interface Viewport {
  width: number;
  height: number;
}
export interface Screen {
  id: string;
  title: string;
  lane?: string;
  note?: string;
  badges: Badge[];
  /** Body HTML the agent wrote, in its own style. */
  html?: string;
  /** HTML file relative to the feature directory, instead of html. */
  file?: string;
  viewport?: Viewport;
}
export interface Edge {
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
}
export interface Flow {
  version: 1;
  title: string;
  subtitle?: string;
  /** Shared <head> HTML for every screen: the agent's styles. */
  style?: string;
  viewport?: Viewport;
  lanes: Lane[];
  screens: Screen[];
  edges: Edge[];
  notes: string[];
}
export interface Issue {
  file: string;
  line: number;
  col: number;
  message: string;
  hint?: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

type Path = (string | number)[];

function locate(doc: Document, lc: LineCounter, path: Path): { line: number; col: number } {
  // Walk as deep as the path exists; report the deepest node found.
  let node: Node | null = doc.contents as Node | null;
  let range = node?.range;
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown })?.value === key);
      if (!pair) break;
      node = pair.value as Node | null;
      range = node?.range ?? (pair.key as Node).range;
    } else if (isSeq(node) && typeof key === "number") {
      node = node.items[key] as Node | null;
      if (!node) break;
      range = node.range;
    } else break;
  }
  const pos = lc.linePos(range?.[0] ?? 0);
  return { line: pos.line, col: pos.col };
}

function pointerToPath(pointer: string): Path {
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export function parseFlow(text: string, file: string): { flow?: Flow; issues: Issue[] } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const issues: Issue[] = [];
  const at = (path: Path, message: string, hint?: string) =>
    issues.push({ file, ...locate(doc, lc, path), message, hint });

  if (doc.errors.length) {
    for (const e of doc.errors) {
      const pos = lc.linePos(e.pos[0]);
      issues.push({ file, line: pos.line, col: pos.col, message: e.message.split("\n")[0], hint: "Fix the YAML syntax." });
    }
    return { issues };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = doc.toJS();
  if (!validate(structuredClone(raw))) {
    for (const err of validate.errors ?? []) {
      const path = pointerToPath(err.instancePath);
      let message = `${err.instancePath || "/"} ${err.message}`;
      if (err.keyword === "enum") message += `: ${(err.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
      if (err.keyword === "additionalProperties")
        message = `${err.instancePath || "/"} has unknown field "${(err.params as { additionalProperty: string }).additionalProperty}"`;
      at(path, message, "See schema/flow.v1.json for the allowed fields and values.");
    }
    return { issues };
  }

  const flow: Flow = {
    version: 1,
    title: raw.title,
    subtitle: raw.subtitle,
    style: raw.style,
    viewport: raw.viewport,
    lanes: (raw.lanes ?? []).map((l: Lane) => ({ ...l, tone: l.tone ?? "neutral" })),
    screens: raw.screens.map((s: Screen) => ({ ...s, badges: s.badges ?? [] })),
    edges: (raw.edges ?? []).map((e: Edge) => ({ ...e, kind: e.kind ?? "normal" })),
    notes: raw.notes ?? [],
  };

  const laneIds = new Set<string>();
  flow.lanes.forEach((l, i) => {
    if (laneIds.has(l.id)) at(["lanes", i, "id"], `duplicate lane id "${l.id}"`, "Give each lane a unique id.");
    laneIds.add(l.id);
  });
  const screenIds = new Set<string>();
  flow.screens.forEach((s, i) => {
    if (screenIds.has(s.id)) at(["screens", i, "id"], `duplicate screen id "${s.id}"`, "Give each screen a unique id, e.g. P02.");
    screenIds.add(s.id);
    if (s.lane && !laneIds.has(s.lane))
      at(["screens", i, "lane"], `screen ${s.id} refers to unknown lane "${s.lane}"`, `Use one of: ${[...laneIds].join(", ") || "(no lanes defined)"}.`);
    if (s.html !== undefined && s.file !== undefined)
      at(["screens", i, "id"], `screen ${s.id} has both html and file`, "Use html for inline markup or file for a separate .html file, not both.");
  });
  flow.edges.forEach((e, i) => {
    for (const end of ["from", "to"] as const)
      if (!screenIds.has(e[end]))
        at(["edges", i, end], `edge ${end} refers to unknown screen "${e[end]}"`, "Edges connect screen ids declared under screens.");
  });

  return { flow: issues.length ? undefined : flow, issues };
}
