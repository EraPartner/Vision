import type { ModelPortfolio } from "@/lib/api/crossWorkspace";

export const REBALANCE_MODELS: readonly ModelPortfolio[] = [
    "sixty_forty",
    "all_weather",
    "three_fund",
];
export const REBALANCE_SLEEVES = [
    "stocks",
    "intl_stocks",
    "bonds",
    "gold",
    "commodities",
    "crypto",
    "real_estate",
    "savings",
] as const;

export interface RebalanceDraftRow {
    sleeve: string;
    pct: string;
}

export interface RebalanceUrlDraft {
    source: string;
    rows: RebalanceDraftRow[];
    name: string;
    capEnabled: boolean;
    cap: string;
}

const DEFAULT_ROWS: RebalanceDraftRow[] = [
    { sleeve: "stocks", pct: "60" },
    { sleeve: "bonds", pct: "40" },
];

export function defaultRebalanceDraft(): RebalanceUrlDraft {
    return {
        source: "model:sixty_forty",
        rows: DEFAULT_ROWS.map((row) => ({ ...row })),
        name: "",
        capEnabled: false,
        cap: "",
    };
}

function validSource(raw: string | null): string {
    if (!raw) return "model:sixty_forty";
    if (
        raw === "custom" ||
        REBALANCE_MODELS.some((model) => raw === `model:${model}`) ||
        (raw.startsWith("plan:") && raw.length > 5 && raw.length <= 133)
    ) {
        return raw;
    }
    return "model:sixty_forty";
}

export function parseRebalanceUrl(params: URLSearchParams): RebalanceUrlDraft {
    const source = validSource(params.get("source"));
    const rows = params
        .getAll("target")
        .slice(0, REBALANCE_SLEEVES.length)
        .map((raw) => {
            const separator = raw.indexOf(":");
            if (separator < 0) return undefined;
            const sleeve = raw.slice(0, separator);
            const pct = raw.slice(separator + 1).slice(0, 32);
            if (
                sleeve !== "" &&
                !REBALANCE_SLEEVES.includes(
                    sleeve as (typeof REBALANCE_SLEEVES)[number],
                )
            ) {
                return undefined;
            }
            return { sleeve, pct };
        })
        .filter((row): row is RebalanceDraftRow => row !== undefined);

    return {
        source,
        rows: rows.length > 0 ? rows : DEFAULT_ROWS.map((row) => ({ ...row })),
        name: (params.get("name") ?? "").slice(0, 80),
        capEnabled: params.has("cap"),
        cap: (params.get("cap") ?? "").slice(0, 32),
    };
}

export function writeRebalanceUrl(
    previous: URLSearchParams,
    draft: RebalanceUrlDraft,
): URLSearchParams {
    const next = new URLSearchParams(previous);
    for (const key of ["source", "target", "name", "cap"]) next.delete(key);

    if (draft.source !== "model:sixty_forty") {
        next.set("source", validSource(draft.source));
    }
    if (!draft.source.startsWith("model:")) {
        for (const row of draft.rows.slice(0, REBALANCE_SLEEVES.length)) {
            next.append("target", `${row.sleeve}:${row.pct.slice(0, 32)}`);
        }
        if (draft.name) next.set("name", draft.name.slice(0, 80));
        if (draft.capEnabled) next.set("cap", draft.cap.slice(0, 32));
    }
    return next;
}
