import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/core/flow.ts";
import { FRAME_H, FRAME_W, layoutFlow } from "../src/core/layout.ts";

const file = join(import.meta.dirname, "..", "examples", "notely", ".design-flow", "sign-up", "flow.yaml");

describe("Notely sign-up example", () => {
  it("is a clean flow with 13 screens in three lanes", () => {
    const { flow, issues } = parseFlow(readFileSync(file, "utf8"), file);
    expect(issues).toEqual([]);
    expect(flow!.screens).toHaveLength(13);
    expect(flow!.lanes.map((l) => l.id)).toEqual(["signup", "signin", "errors"]);
  });

  it("lays out with no overlapping frames", async () => {
    const flow = parseFlow(readFileSync(file, "utf8"), file).flow!;
    const l = await layoutFlow(flow);
    const boxes = Object.entries(l.screens);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, A] = boxes[i];
        const [b, B] = boxes[j];
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
        expect(overlap, `${a} overlaps ${b}`).toBe(false);
      }
  });
});
