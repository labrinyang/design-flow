import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { useState } from "react";
import type { FlowEdge } from "./model.ts";

/** Within a handle's few pixels of where the route expects a line end. */
const near = (a: number, b: number) => Math.abs(a - b) < 8;

export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const route = data?.route;
  // The routed line holds while both frames sit where the layout put them; while one is dragged, a plain step line follows it.
  const routed = !!route && near(sourceX, route.ends.sx) && near(sourceY, route.ends.sy) && near(targetX, route.ends.tx) && near(targetY, route.ends.ty);
  const backwards = targetX < sourceX;
  const [stepPath, stepX, stepY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 6,
    offset: backwards ? 28 : 20,
  });
  const path = routed ? route.d : stepPath;
  const labelX = routed && route.label ? route.label.x : stepX;
  const labelY = routed && route.label ? route.label.y : stepY;
  const tone = data?.tone ?? "neutral";
  const color = `var(--edge-${tone})`;
  // While a screen is in focus, its lines stand out and the others fall back (canvas.tsx).
  const faded = !!data?.faded;
  const opacity = faded ? 0.1 : data?.focus ? 0.95 : 0.6;
  const marker = `arrow-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  // Hovering the line or its label lights the line itself (shown only while commenting, see index.css).
  const [hover, setHover] = useState(false);
  const on = () => setHover(true);
  const off = () => setHover(false);
  // A line into or out of a collapsed lane stands for several edges: a click on it comments on the canvas there.
  const anchor = data?.folded ? undefined : "edge";
  return (
    <>
      {/* Per-edge marker inside the edge's own SVG so PNG export (which clones the viewport) keeps arrowheads. */}
      <defs>
        <marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,1 L8,5 L0,9" fill="none" stroke={color} strokeWidth="1.6" strokeOpacity={faded ? 0.15 : 1} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${marker})`}
        className="df-edge"
        data-hover={hover}
        data-marked={!!data?.marked}
        style={{
          stroke: color,
          strokeWidth: data?.focus ? 2.6 : 2.2,
          strokeOpacity: opacity,
          strokeDasharray: data?.dashed ? "6 5" : undefined,
          transition: "stroke-opacity 120ms ease",
        }}
        interactionWidth={18}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        data-anchor={anchor}
        data-from={data?.edge.from}
        data-to={data?.edge.to}
        data-index={data?.index}
        className="react-flow__edge-interaction"
        onMouseEnter={anchor && on}
        onMouseLeave={anchor && off}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            data-anchor={anchor}
            data-edge-label
            data-from={data.edge.from}
            data-to={data.edge.to}
            data-index={data.index}
            onMouseEnter={anchor && on}
            onMouseLeave={anchor && off}
            className="nodrag nopan pointer-events-auto absolute rounded-md px-1.5 py-px text-[13px] font-medium whitespace-nowrap"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color,
              background: "var(--canvas)",
              opacity: faded ? 0 : 1,
              pointerEvents: faded ? "none" : undefined,
              transition: "opacity 120ms ease",
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
