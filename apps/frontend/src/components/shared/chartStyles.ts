/**
 * Shared Recharts tooltip styling — keeps every chart tooltip visually consistent.
 */
export const chartTooltipStyle: React.CSSProperties = {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "12px",
    padding: "12px",
    boxShadow: "0 8px 24px -4px rgba(0,0,0,0.12), 0 2px 8px -2px rgba(0,0,0,0.08)",
    backdropFilter: "blur(8px)",
    fontSize: "13px",
    lineHeight: "1.5",
};

export const chartTooltipLabelStyle: React.CSSProperties = {
    fontWeight: 600,
    marginBottom: "4px",
    color: "hsl(var(--foreground))",
};
