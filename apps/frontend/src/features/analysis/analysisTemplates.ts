import type { AnalysisWorkspace, VisualAnalysisPlan } from "@/lib/api/analysis";

export interface AnalysisTemplate {
    id: string;
    workspace: AnalysisWorkspace;
    titleKey: string;
    descriptionKey: string;
    plan: VisualAnalysisPlan;
}

export const ANALYSIS_TEMPLATES: readonly AnalysisTemplate[] = [
    {
        id: "monthly-category-spending",
        workspace: "budgeting",
        titleKey: "analysis.template.monthlyCategory.title",
        descriptionKey: "analysis.template.monthlyCategory.description",
        plan: {
            datasetId: "cash-flows",
            fields: ["month", "category_general"],
            filters: [
                { fieldId: "is_transfer", operator: "eq", value: false },
                { fieldId: "is_active", operator: "eq", value: true },
            ],
            groups: ["month", "category_general"],
            measures: ["sum_spending"],
            joins: [],
            orderBy: [{ id: "month", direction: "asc" }],
            limit: 500,
        },
    },
    {
        id: "monthly-cash-flow",
        workspace: "budgeting",
        titleKey: "analysis.template.cashFlow.title",
        descriptionKey: "analysis.template.cashFlow.description",
        plan: {
            datasetId: "cash-flows",
            fields: ["month", "currency"],
            filters: [
                { fieldId: "is_transfer", operator: "eq", value: false },
                { fieldId: "is_active", operator: "eq", value: true },
            ],
            groups: ["month", "currency"],
            measures: ["sum_spending", "sum_positive_flow", "sum_amount"],
            joins: [],
            orderBy: [{ id: "month", direction: "asc" }],
            limit: 500,
        },
    },
    {
        id: "portfolio-activity",
        workspace: "portfolio",
        titleKey: "analysis.template.portfolioActivity.title",
        descriptionKey: "analysis.template.portfolioActivity.description",
        plan: {
            datasetId: "holdings",
            fields: ["month", "asset_class", "currency"],
            filters: [],
            groups: ["month", "asset_class", "currency"],
            measures: ["count", "sum_amount"],
            joins: [],
            orderBy: [{ id: "month", direction: "asc" }],
            limit: 500,
        },
    },
];

export const cloneAnalysisPlan = (
    plan: VisualAnalysisPlan,
): VisualAnalysisPlan => structuredClone(plan);
