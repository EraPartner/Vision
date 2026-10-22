/**
 * SankeyChart — Sankey flow diagram.
 *
 * Renders money flow from income to spending categories for a given year.
 * Layout comes from the in-repo port of d3-sankey (sankeyLayout.ts).
 */
import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { getCategoryChartColor } from "@/utils/categoryColors";
import type { SankeyFlowData } from "@/lib/api/aggregations";
import { localizeSankeyLabel, sankeyColorKey } from "./sankeyLabels";
import { sankeyLayout, sankeyLinkPath, type SankeyLayout } from "./sankeyLayout";

interface SankeyChartProps {
    readonly data: SankeyFlowData;
    readonly height?: number;
}

type NodeExtra = { id: string; label: string; value: number };

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };
const NODE_WIDTH = 16;
const NODE_PADDING = 18;

function SankeyInner({
    data,
    width,
    height,
}: {
    data: SankeyFlowData;
    width: number;
    height: number;
}) {
    const { t } = useLanguage();
    const { formatCurrency } = useChartCurrencyFormatter();
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [hoveredLinkIndex, setHoveredLinkIndex] = useState<number | null>(
        null,
    );

    const innerWidth = width - MARGIN.left - MARGIN.right;
    const innerHeight = height - MARGIN.top - MARGIN.bottom;

    const graph = useMemo<SankeyLayout<NodeExtra> | null>(() => {
        if (data.nodes.length === 0 || data.links.length === 0) return null;

        const nodes = data.nodes.map((n) => ({
            ...n,
            label: localizeSankeyLabel(n.id, n.label, t),
        }));

        try {
            return sankeyLayout(
                { nodes, links: data.links },
                {
                    nodeWidth: NODE_WIDTH,
                    nodePadding: NODE_PADDING,
                    extent: [
                        [0, 0],
                        [innerWidth, innerHeight],
                    ],
                },
            );
        } catch {
            return null;
        }
    }, [data, innerWidth, innerHeight, t]);

    // Color by stable node identity, not translated display text or node index.
    const nodeColorMap = useMemo(() => {
        const map = new Map<string, string>();
        data.nodes.forEach((n) =>
            map.set(n.id, getCategoryChartColor(sankeyColorKey(n.id, n.label))),
        );
        return map;
    }, [data.nodes]);

    if (!graph || width < 2) return null;

    return (
        <svg width={width} height={height}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                {/* Links */}
                {graph.links.map((link, i) => {
                    const sourceId = link.source.id;
                    const targetId = link.target.id;
                    const color =
                        nodeColorMap.get(targetId) ??
                        "hsl(var(--muted-foreground))";
                    const isHovered =
                        hoveredLinkIndex === i ||
                        hoveredNodeId === sourceId ||
                        hoveredNodeId === targetId;
                    const d = sankeyLinkPath(link);

                    return (
                        <path
                            key={`link-${i}`}
                            d={d}
                            fill="none"
                            stroke={color}
                            strokeWidth={Math.max(1, link.width)}
                            strokeOpacity={isHovered ? 0.6 : 0.25}
                            style={{
                                cursor: "default",
                                transition:
                                    "stroke-opacity var(--duration-fast)",
                            }}
                            onMouseEnter={() => setHoveredLinkIndex(i)}
                            onMouseLeave={() => setHoveredLinkIndex(null)}
                        />
                    );
                })}

                {/* Nodes */}
                {graph.nodes.map((node) => {
                    const x0 = node.x0;
                    const x1 = node.x1;
                    const y0 = node.y0;
                    const y1 = node.y1;
                    const nodeHeight = Math.max(1, y1 - y0);
                    const color =
                        nodeColorMap.get(node.id) ??
                        "hsl(var(--muted-foreground))";
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
                                style={{
                                    transition: "opacity var(--duration-fast)",
                                }}
                            />
                            {/* Label */}
                            <text
                                x={isRight ? x0 - 6 : x1 + 6}
                                y={y0 + nodeHeight / 2}
                                dy="0.35em"
                                textAnchor={isRight ? "end" : "start"}
                                fontSize={11}
                                fill="hsl(var(--foreground))"
                                style={{
                                    pointerEvents: "none",
                                    userSelect: "none",
                                }}
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
                                    style={{
                                        pointerEvents: "none",
                                        userSelect: "none",
                                    }}
                                >
                                    {formatCurrency(node.value)}
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

    if (data.nodes.length === 0) {
        return (
            <div className="flex h-40 items-center justify-center type-callout text-label-secondary">
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
