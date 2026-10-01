import type { AnalysisResult } from "@/lib/api/analysis";
export interface AnalysisChartSpec {
    kind: "bar" | "line" | "stacked-bar" | "scatter" | "waterfall";
    x: string;
    y: string[];
}
export function normalizeAnalysisChartSpec(value: unknown): AnalysisChartSpec {
    const v = value as Partial<AnalysisChartSpec> | undefined;
    const kinds = ["bar", "line", "stacked-bar", "scatter", "waterfall"];
    return {
        kind: kinds.includes(v?.kind ?? "") ? v!.kind! : "bar",
        x: typeof v?.x === "string" ? v.x : "",
        y:
            typeof v?.y === "string"
                ? [v.y]
                : Array.isArray(v?.y)
                  ? [
                        ...new Set(
                            v.y.filter(
                                (id): id is string => typeof id === "string",
                            ),
                        ),
                    ]
                  : [],
    };
}
export function isAnalysisResultComplete(result: AnalysisResult): boolean {
    return (
        result.window.kind === "page" &&
        result.window.offset === 0 &&
        !result.window.hasMore &&
        result.complete !== false &&
        result.coverage?.complete !== false &&
        result.coverage?.status !== "partial" &&
        !(result.transformationCoverage ?? []).some(
            (c) => c.complete === false,
        ) &&
        !(result.transformationErrors ?? []).length
    );
}
export function analysisChartData(
    result: AnalysisResult,
    spec: AnalysisChartSpec,
) {
    const complete = isAnalysisResultComplete(result);
    const currencies = new Set(
        result.rows
            .map((r) => r.currency ?? r.reporting_currency)
            .filter((v) => v != null),
    );
    const instrumentUnits =
        spec.y.some((id) => /units|quantity/.test(id)) &&
        new Set(
            result.rows
                .map((r) => r.investment_id ?? r.instrument_id)
                .filter((v) => v != null),
        ).size > 1;
    const columns = result.declaredColumns?.length
        ? result.declaredColumns
        : result.columns;
    let missingUnitScope = false;
    const units = new Set(
        spec.y
            .map((id) => {
                const unit = columns.find((c) => c.id === id)?.unit;
                if (!unit) return "unspecified";
                if (typeof unit === "string") return unit;
                if (unit.kind === "money" && !unit.currency) {
                    const currencyColumn = unit.currencyColumn;
                    if (
                        !currencyColumn ||
                        result.rows.some((row) => !row[currencyColumn])
                    )
                        missingUnitScope = true;
                    const scope = new Set(
                        result.rows.map((row) =>
                            currencyColumn ? row[currencyColumn] : undefined,
                        ),
                    );
                    if (scope.size > 1) missingUnitScope = true;
                }
                if (
                    unit.instrumentColumn &&
                    result.rows.some(
                        (row) => row[unit.instrumentColumn!] == null,
                    )
                )
                    missingUnitScope = true;
                if (
                    unit.instrumentColumn &&
                    new Set(
                        result.rows.map((row) => row[unit.instrumentColumn!]),
                    ).size > 1
                )
                    missingUnitScope = true;
                return JSON.stringify([
                    unit.kind,
                    unit.currency ??
                        (unit.currencyColumn
                            ? result.rows[0]?.[unit.currencyColumn]
                            : ""),
                    unit.instrumentColumn
                        ? result.rows[0]?.[unit.instrumentColumn]
                        : "",
                    unit.percentageBasis ?? "",
                ]);
            })
            .filter(Boolean),
    );
    const incompatible =
        currencies.size > 1 ||
        instrumentUnits ||
        units.size > 1 ||
        missingUnitScope;
    let omitted = 0;
    const rows = result.rows.map((row, index) => {
        const values = spec.y.map((id) => {
            const v = row[id];
            return v === null ||
                v === undefined ||
                v === "" ||
                typeof v === "boolean" ||
                !Number.isFinite(Number(v))
                ? null
                : Number(v);
        });
        const x = row[spec.x];
        if (
            values.some((v) => v === null) ||
            (spec.kind === "scatter" &&
                (x == null ||
                    x === "" ||
                    typeof x === "boolean" ||
                    !Number.isFinite(Number(x))))
        )
            omitted++;
        return {
            index,
            label: String(x ?? "—"),
            x:
                x == null || x === "" || typeof x === "boolean"
                    ? NaN
                    : Number(x),
            values,
            rawValues: spec.y.map((id) => row[id]),
        };
    });
    return { complete, incompatible, omitted, rows };
}
