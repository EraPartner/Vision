/** Existing ToolResultCard inference. Arrays inside result arrays are intentionally rows. */
export type ToolRow = Record<string, unknown>;
export function toolResultRows(data: unknown): ToolRow[] {
  if (Array.isArray(data))
    return data.filter(
      (r): r is ToolRow => r !== null && typeof r === "object",
    );
  return data && typeof data === "object" ? [data as ToolRow] : [];
}
export function toolResultColumns(
  rows: ToolRow[],
  preferred?: string[],
): string[] {
  if (preferred && preferred.length > 0) return preferred;
  return rows[0] === undefined ? [] : Object.keys(rows[0]);
}
export function toolResultAxes(
  rows: ToolRow[],
  xKey?: string,
  yKeys?: string[],
) {
  const first = rows[0];
  const xk = xKey ?? (first === undefined ? "" : (Object.keys(first)[0] ?? ""));
  const yk =
    yKeys && yKeys.length > 0
      ? yKeys
      : first === undefined
        ? []
        : Object.keys(first).filter(
            (key) => key !== xk && typeof first[key] === "number",
          );
  return { xk, yk };
}
export interface ToolPieRow {
  name: string;
  value: number;
  percent: number;
  labelPercent: number;
  startAngle: number;
  endAngle: number;
}
export interface ToolPresentation {
  renderAs: string;
  rows: ToolRow[];
  columns: string[];
  xKey: string;
  yKeys: string[];
  rowCount: number;
  pieRenderable: boolean;
  pieRows: ToolPieRow[];
}
/** Called on wire-normalized JSON, before Swift loses object member order. Never modifies the result. */
export function toolResultPresentation(
  result: unknown,
): ToolPresentation | null {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const envelope = result as Record<string, unknown>;
  const rows = toolResultRows(envelope.ok ? envelope.data : null);
  const meta =
    envelope.meta && typeof envelope.meta === "object"
      ? (envelope.meta as Record<string, unknown>)
      : {};
  const columns = toolResultColumns(
    rows,
    Array.isArray(meta.columns) ? (meta.columns as string[]) : undefined,
  );
  const { xk, yk } = toolResultAxes(
    rows,
    typeof meta.xKey === "string" ? meta.xKey : undefined,
    Array.isArray(meta.yKeys) ? (meta.yKeys as string[]) : undefined,
  );
  const renderAs =
    typeof meta.renderAs === "string"
      ? meta.renderAs
      : rows.length > 0
        ? "table"
        : "json";
  const key = yk[0];
  const pieData = key
    ? rows.map((row) => ({
        name: String(row[xk] ?? ""),
        value: typeof row[key] === "number" ? (row[key] as number) : 0,
      }))
    : [];
  // Recharts Pie's defaults: start=0, end=360, minAngle=0, paddingAngle=0.
  // Its sum and percent retain negative values; no sectors are composed when sum <= 0.
  const sum = pieData.reduce((total, row) => total + row.value, 0);
  let previousEnd = 0;
  const pieRows =
    sum > 0
      ? pieData.map((row) => {
          const percent = row.value / sum;
          const startAngle = previousEnd;
          const endAngle = startAngle + percent * 360;
          previousEnd = endAngle;
          return {
            ...row,
            percent,
            labelPercent: percent * 100,
            startAngle,
            endAngle,
          };
        })
      : [];
  return {
    renderAs,
    rows,
    columns,
    xKey: xk,
    yKeys: yk,
    rowCount: rows.length,
    pieRenderable: pieRows.length > 0,
    pieRows,
  };
}
