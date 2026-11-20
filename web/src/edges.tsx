import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { useState } from "react";
import type { FlowEdge } from "./model.ts";

export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const backwards = targetX < sourceX;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 6,
    offset: backwards ? 28 : 20,
  });
  const tone = data?.tone ?? "neutral";
  const color = `var(--edge-${tone})`;
  const marker = `arrow-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  // Hovering the line or its label lights the line itself (shown only while commenting, see index.css).
  const [hover, setHover] = useState(false);
  const on = () => setHover(true);
  const off = () => setHover(false);
  return (
    <>
      {/* Per-edge marker inside the edge's own SVG so PNG export (which clones the viewport) keeps arrowheads. */}
      <defs>
        <marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,1 L8,5 L0,9" fill="none" stroke={color} strokeWidth="1.6" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${marker})`}
        className="df-edge"
        data-hover={hover}
        data-marked={!!data?.marked}
        style={{ stroke: color, strokeWidth: 2.2, strokeOpacity: 0.6, strokeDasharray: data?.dashed ? "6 5" : undefined }}
        interactionWidth={18}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        data-anchor="edge"
        data-from={data?.edge.from}
        data-to={data?.edge.to}
        data-index={data?.index}
        className="react-flow__edge-interaction"
        onMouseEnter={on}
        onMouseLeave={off}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            data-anchor="edge"
            data-from={data.edge.from}
            data-to={data.edge.to}
            data-index={data.index}
            onMouseEnter={on}
            onMouseLeave={off}
            className="nodrag nopan pointer-events-auto absolute rounded-md px-1.5 py-px text-[13px] font-medium whitespace-nowrap"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color,
              background: "var(--canvas)",
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
