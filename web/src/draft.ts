import type { Anchor, Point } from "../../src/core/comments.ts";
import type { Flow } from "../../src/core/flow.ts";

const GAP = 16;
const EDGE = 12;

/** Where the new-comment box sits, in the canvas's own pixels, beside the marker it belongs to. */
export function placeDraft(
  marker: Point,
  box: { width: number; height: number },
  room: { width: number; height: number },
  /** Pixels at the room's bottom taken by the floating toolbar. */
  bottomInset = 0,
) {
  const right = marker.x + GAP;
  const left = right + box.width > room.width - EDGE ? marker.x - GAP - box.width : right;
  const top = Math.min(Math.max(marker.y - 20, EDGE), room.height - bottomInset - box.height - EDGE);
  return { left, top };
}

/** What on the canvas a comment anchor points at, so it can be highlighted while the comment is written. */
export interface Mark {
  screen?: string;
  /** CSS selector of the element inside `screen`. */
  selector?: string;
  /** React Flow edge id. */
  edge?: string;
  lane?: string;
}

export function markOf(anchor: Anchor, flow: Flow): Mark {
  switch (anchor.type) {
    case "element":
      return { screen: anchor.screen, selector: anchor.selector };
    case "screen":
      return { screen: anchor.screen };
    case "lane":
      return { lane: anchor.lane };
    case "edge": {
      const { from, to, index } = anchor.edge;
      const first = flow.edges.findIndex((e) => e.from === from && e.to === to);
      return { edge: index === undefined || index === first ? `${from}->${to}` : `${from}->${to}#${index}` };
    }
    default:
      return {};
  }
}
