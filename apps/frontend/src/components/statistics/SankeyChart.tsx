/**
 * SankeyChart — d3-sankey flow diagram.
 *
 * Renders money flow from income to spending categories for a given year.
 * Deep-clones input data before passing to d3-sankey because the library
 * mutates node/link objects in-place during layout computation.
 */
import { useMemo, useState, useCallback } from "react";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import type { SankeyGraph, SankeyNode, SankeyLink } from "d3-sankey";
import { ParentSize } from "@visx/responsive";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { SankeyFlowData } from "@/lib/api/aggregations";

interface SankeyChartProps {
  readonly data: SankeyFlowData;
  readonly height?: number;
}

type NodeExtra = { id: string; label: string; value: number };
type LinkExtra = { value: number };

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };
const NODE_WIDTH = 16;
const NODE_PADDING = 18;
const NODE_COLORS = [
  "hsl(var(--primary))",
  "hsl(220 70% 50%)",
  "hsl(262 80% 60%)",
  "hsl(330 70% 55%)",
  "hsl(14 80% 55%)",
  "hsl(48 90% 50%)",
  "hsl(165 60% 45%)",
  "hsl(200 65% 50%)",
  "hsl(290 60% 55%)",
  "hsl(35 75% 52%)",
  "hsl(130 55% 45%)",
  "hsl(0 70% 55%)",
  "hsl(180 55% 45%)",
  "hsl(var(--muted-foreground))",
];

function getNodeColor(index: number): string {
  return NODE_COLORS[index % NODE_COLORS.length];
}

function SankeyInner({
  data,
  width,
  height,
}: {
  data: SankeyFlowData;
  width: number;
  height: number;
}) {
  const { formatCurrency } = useChartCurrencyFormatter();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredLinkIndex, setHoveredLinkIndex] = useState<number | null>(null);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  const graph = useMemo<SankeyGraph<NodeExtra, LinkExtra> | null>(() => {
    if (!data.nodes.length || !data.links.length) return null;

    // Deep clone — d3-sankey mutates node/link objects in-place
    const clonedNodes = data.nodes.map((n) => ({ ...n }));
    const clonedLinks = data.links.map((l) => ({ ...l }));

    const sankeyGen = sankey<NodeExtra, LinkExtra>()
      .nodeId((d) => d.id)
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .extent([
        [0, 0],
        [innerWidth, innerHeight],
      ]);

    try {
      // Pass string IDs — d3-sankey resolves them via nodeId internally
      return sankeyGen({ nodes: clonedNodes, links: clonedLinks });
    } catch {
      return null;
    }
  }, [data, innerWidth, innerHeight]);

  const nodeColorMap = useMemo(() => {
    const map = new Map<string, string>();
    data.nodes.forEach((n, i) => map.set(n.id, getNodeColor(i)));
    return map;
  }, [data.nodes]);

  if (!graph || width < 2) return null;

  const pathGen = sankeyLinkHorizontal();

  return (
    <svg width={width} height={height}>
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {/* Links */}
        {graph.links.map((link, i) => {
          const sourceId = (link.source as SankeyNode<NodeExtra, LinkExtra>).id;
          const targetId = (link.target as SankeyNode<NodeExtra, LinkExtra>).id;
          const color = nodeColorMap.get(targetId) ?? "hsl(var(--muted-foreground))";
          const isHovered = hoveredLinkIndex === i ||
            hoveredNodeId === sourceId ||
            hoveredNodeId === targetId;
          const d = pathGen(link as Parameters<typeof pathGen>[0]);

          return (
            <path
              key={`link-${i}`}
              d={d ?? ""}
              fill="none"
              stroke={color}
              strokeWidth={Math.max(1, link.width ?? 1)}
              strokeOpacity={isHovered ? 0.6 : 0.25}
              style={{ cursor: "default", transition: "stroke-opacity 150ms" }}
              onMouseEnter={() => setHoveredLinkIndex(i)}
              onMouseLeave={() => setHoveredLinkIndex(null)}
            />
          );
        })}

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const x0 = node.x0 ?? 0;
          const x1 = node.x1 ?? 0;
          const y0 = node.y0 ?? 0;
          const y1 = node.y1 ?? 0;
          const nodeHeight = Math.max(1, y1 - y0);
          const color = nodeColorMap.get(node.id) ?? "hsl(var(--muted-foreground))";
          const isRight = x0 > innerWidth / 2;
          const isHovered = hoveredNodeId === node.id;

          return (
            <g
              key={`node-${node.id}`}
              onMouseEnter={() => setHoveredNodeId(node.id)}
              onMouseLeave={() => setHoveredNodeId(null)}
              style={{ cursor: "default" }}
            >
              <rect
                x={x0}
                y={y0}
                width={x1 - x0}
                height={nodeHeight}
                fill={color}
                opacity={isHovered ? 1 : 0.85}
                rx={3}
                style={{ transition: "opacity 150ms" }}
              />
              {/* Label */}
              <text
                x={isRight ? x0 - 6 : x1 + 6}
                y={y0 + nodeHeight / 2}
                dy="0.35em"
                textAnchor={isRight ? "end" : "start"}
                fontSize={11}
                fill="hsl(var(--foreground))"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {node.label}
              </text>
              {/* Value on hover */}
              {isHovered && (
                <text
                  x={isRight ? x0 - 6 : x1 + 6}
                  y={y0 + nodeHeight / 2 + 14}
                  dy="0.35em"
                  textAnchor={isRight ? "end" : "start"}
                  fontSize={10}
                  fill="hsl(var(--muted-foreground))"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {formatCurrency(node.value ?? 0)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function SankeyChart({ data, height = 420 }: SankeyChartProps) {
  const { t } = useLanguage();

  if (!data.nodes.length) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        {t("statsPage.sankey.noData")}
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height }}>
      <ParentSize>
        {({ width }) => (
          <SankeyInner data={data} width={width} height={height} />
        )}
      </ParentSize>
    </div>
  );
}
