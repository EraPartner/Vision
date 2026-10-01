import type {
    AnalysisDataset,
    AnalysisResult,
    AnalysisValue,
} from "@/lib/api/analysis";
import { numberFormatToLocale } from "@/utils/currency";

const catalogKeys: Record<string, string> = {
    Transactions: "analysis.catalog.Transactions",
    Accounts: "analysis.catalog.Accounts",
    "Holding events": "analysis.catalog.Holding_events",
    "Cash flows": "analysis.catalog.Cash_flows",
    "Transaction ID": "analysis.catalog.Transaction_ID",
    Date: "analysis.catalog.Date",
    Month: "analysis.catalog.Month",
    Amount: "analysis.catalog.Amount",
    Currency: "analysis.catalog.Currency",
    "Account ID": "analysis.catalog.Account_ID",
    Account: "analysis.catalog.Account",
    Recipient: "analysis.catalog.Recipient",
    Category: "analysis.catalog.Category",
    "Category detail": "analysis.catalog.Category_detail",
    "Category path": "analysis.catalog.Category_path",
    "Category path segments": "analysis.catalog.Category_path_segments",
    "Category path IDs": "analysis.catalog.Category_path_IDs",
    Memo: "analysis.catalog.Memo",
    Comment: "analysis.catalog.Comment",
    Transfer: "analysis.catalog.Transfer",
    Active: "analysis.catalog.Active",
    "Account display name": "analysis.catalog.Account_display_name",
    "Account institution": "analysis.catalog.Account_institution",
    "Transaction count": "analysis.catalog.Transaction_count",
    "Net amount": "analysis.catalog.Net_amount",
    "Display name": "analysis.catalog.Display_name",
    Institution: "analysis.catalog.Institution",
    "Account type": "analysis.catalog.Account_type",
    Owner: "analysis.catalog.Owner",
    "Account count": "analysis.catalog.Account_count",
    "Event ID": "analysis.catalog.Event_ID",
    Investment: "analysis.catalog.Investment",
    Symbol: "analysis.catalog.Symbol",
    "Asset class": "analysis.catalog.Asset_class",
    "Event type": "analysis.catalog.Event_type",
    Units: "analysis.catalog.Units",
    "Event count": "analysis.catalog.Event_count",
    "Raw event amount total": "analysis.catalog.Raw_event_amount_total",
    "Raw event units total": "analysis.catalog.Raw_event_units_total",
    "Investment ID": "analysis.catalog.Investment_ID",
    "Cash-flow ID": "analysis.catalog.Cash_flow_ID",
    "Signed amount": "analysis.catalog.Signed_amount",
    Spending: "analysis.catalog.Spending",
    "Income and refunds": "analysis.catalog.Income_and_refunds",
    "Flow type": "analysis.catalog.Flow_type",
    "Cash-flow count": "analysis.catalog.Cash_flow_count",
    "Net cash flow": "analysis.catalog.Net_cash_flow",
};

export function analysisCatalogLabel(
    label: string,
    t: (key: string) => string,
): string {
    return catalogKeys[label] ? t(catalogKeys[label]) : label;
}

export function analysisColumnLabel(
    result: AnalysisResult,
    id: string,
    datasets: AnalysisDataset[],
    t: (key: string) => string,
): string {
    const declared = result.declaredColumns?.find(
        (column) => column.id === id,
    )?.label;
    const matches = datasets
        .flatMap((dataset) => [...dataset.fields, ...dataset.measures])
        .filter((field) => field.id === id);
    // Explicit aliases are user content. Only catalog labels receive translation.
    if (declared && declared !== id) {
        return matches.some((field) => field.label === declared)
            ? analysisCatalogLabel(declared, t)
            : declared;
    }
    const labels = [...new Set(matches.map((field) => field.label))];
    return labels.length === 1 ? analysisCatalogLabel(labels[0], t) : id;
}

export function formatAnalysisValue(
    value: AnalysisValue | undefined,
    type: string,
    id: string,
    numberFormat: string,
): string {
    if (value == null) return "—";
    if (
        !/^(decimal|number|integer|numeric|float|double)$/.test(type) ||
        /(^|[_.])id$/.test(id)
    )
        return String(value);
    const text = String(value);
    const decimal = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    const locale = numberFormatToLocale(numberFormat);
    // Group the integer separately to preserve database decimals and large integers exactly.
    if (decimal) {
        const integer = new Intl.NumberFormat(locale).format(
            BigInt(decimal[2]),
        );
        const separator =
            new Intl.NumberFormat(locale)
                .formatToParts(1.1)
                .find((part) => part.type === "decimal")?.value ?? ".";
        return `${decimal[1]}${integer}${decimal[3] ? separator + decimal[3] : ""}`;
    }
    return typeof value === "number" && Number.isFinite(value)
        ? new Intl.NumberFormat(locale, {
              maximumSignificantDigits: 21,
          }).format(value)
        : text;
}

export function analysisDraftSignature(inputs: {
    formulasJson: string;
    assumptionsJson: string;
    assumptionValuesJson: string;
    workbench: unknown;
    scenarioModel: unknown;
}) {
    const parseDraft = (raw: string): unknown => {
        try {
            return JSON.parse(raw);
        } catch {
            return { invalidJson: raw };
        }
    };
    return JSON.stringify({
        ...inputs,
        formulasJson: parseDraft(inputs.formulasJson),
        assumptionsJson: parseDraft(inputs.assumptionsJson),
        assumptionValuesJson: parseDraft(inputs.assumptionValuesJson),
    });
}
