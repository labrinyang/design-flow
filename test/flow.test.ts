import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/core/flow.ts";

const valid = `version: 1
title: Checkout
lanes:
  - id: pay
    title: Pay
    tone: info
screens:
  - id: H00
    title: Home
    html: <button data-id="charge">Charge</button>
  - id: P01
    lane: pay
    title: Amount
    html: |
      <input placeholder="Amount">
      <button>Next</button>
edges:
  - { from: H00, to: P01, label: Charge }
`;

describe("parseFlow", () => {
  it("parses a valid flow with no issues", () => {
    const { flow, issues } = parseFlow(valid, "flow.yaml");
    expect(issues).toEqual([]);
    expect(flow?.screens.map((s) => s.id)).toEqual(["H00", "P01"]);
    expect(flow?.edges[0]).toMatchObject({ from: "H00", to: "P01", kind: "normal" });
  });

  it("reports a duplicate screen id at its line", () => {
    const text = valid.replace("id: P01", "id: H00");
    const { issues } = parseFlow(text, "flow.yaml");
    const dup = issues.find((i) => i.message.includes("H00") && i.message.includes("duplicate"));
    expect(dup?.line).toBe(11);
    expect(dup?.file).toBe("flow.yaml");
    expect(dup?.hint).toBeTruthy();
  });

  it("reports an unknown lane", () => {
    const { issues } = parseFlow(valid.replace("lane: pay", "lane: nope"), "f");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 12 });
    expect(issues[0].message).toContain("nope");
  });

  it("reports an unknown edge target", () => {
    const { issues } = parseFlow(valid.replace("to: P01", "to: P99"), "f");
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(18);
    expect(issues[0].message).toContain("P99");
  });

  it("reports a screen with both html and file", () => {
    const text = valid.replace("    html: <button data-id=\"charge\">Charge</button>", "    html: <b>x</b>\n    file: screens/h00.html");
    const { issues } = parseFlow(text, "f");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("H00");
    expect(issues[0].line).toBe(8);
  });

  it("rejects a screen file outside the feature directory", () => {
    const text = valid.replace("    html: <button data-id=\"charge\">Charge</button>", "    file: ../../secret.html");
    const { issues } = parseFlow(text, "f");
    expect(issues[0].message).toContain("file");
  });

  it("keeps a shared style and per-screen viewport", () => {
    const text = valid.replace("title: Checkout\n", "title: Checkout\nstyle: |\n  <style>button{color:red}</style>\nviewport: { width: 390, height: 844 }\n");
    const { flow, issues } = parseFlow(text, "f");
    expect(issues).toEqual([]);
    expect(flow?.style).toContain("button{color:red}");
    expect(flow?.viewport).toEqual({ width: 390, height: 844 });
    expect(flow?.screens[1].html).toContain("<input");
  });

  it("reports schema errors with location", () => {
    const { issues, flow } = parseFlow(valid.replace("tone: info", "tone: purple"), "f");
    expect(flow).toBeUndefined();
    expect(issues[0].line).toBe(6);
    expect(issues[0].message).toContain("tone");
  });

  it("reports YAML syntax errors with location", () => {
    const { issues } = parseFlow("version: 1\ntitle: [oops\n", "f");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].line).toBeGreaterThanOrEqual(2);
  });

  it("accepts enter: any lanes and edge kinds", () => {
    const text = valid
      .replace("tone: info", "tone: info\n    enter: any")
      .replace("label: Charge }", "label: Charge, kind: back }");
    const { issues, flow } = parseFlow(text, "f");
    expect(issues).toEqual([]);
    expect(flow?.lanes[0].enter).toBe("any");
    expect(flow?.edges[0].kind).toBe("back");
  });
});
