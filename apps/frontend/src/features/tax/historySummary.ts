/**
 * Readable summaries of snapshot audit entries for SnapshotHistoryDialog: the compact v1 patch
 * line and the per-section household diff (ADR-200 `householdChanges`).
 */
import type { SnapshotAuditEntry } from "@/lib/belgianTax";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import type { useLanguage } from "@/stores/hydration/LanguageHydration";
import { partnerLabel } from "./profile-steps/householdEditing";

/**
 * Compact one-line summary of a patch. Numbers are formatted, strings are quoted, booleans
 * pass through. Long arrays and objects collapse to `[N items]` / `{N keys}` to keep the
 * timeline scannable.
 */
export function summarizePatch(
    changes:
        | SnapshotAuditEntry["changes"]
        | SnapshotAuditEntry["householdChanges"],
): string {
    if (!changes) return "";
    const parts: string[] = [];
    const entries: Array<[string, unknown]> = Object.entries(changes);
    for (const [k, v] of entries) {
        if (Array.isArray(v)) {
            parts.push(`${k}: [${v.length} items]`);
        } else if (v !== null && typeof v === "object") {
            parts.push(`${k}: {${Object.keys(v).length} keys}`);
        } else if (typeof v === "string") {
            parts.push(`${k}: "${v}"`);
        } else {
            parts.push(`${k}: ${String(v)}`);
        }
    }
    return parts.join(", ");
}

type Translate = ReturnType<typeof useLanguage>["t"];
type Format = (value: number) => string;

const HOUSEHOLD_SECTIONS = [
    "partners",
    "relationship",
    "dependents",
    "home",
    "region",
    "communalSurchargePercent",
    "taxIncomeCategoryIds",
    "profileConfigured",
] as const;

function householdSectionValue(
    changes: Partial<BelgianTaxHouseholdV2>,
    section: (typeof HOUSEHOLD_SECTIONS)[number],
    t: Translate,
    fmt: Format,
): string {
    switch (section) {
        case "partners":
            return (changes.partners ?? [])
                .map((partner) =>
                    t("tax.history.household.partnerSummary", {
                        partner: partnerLabel(t, partner),
                        count: partner.activities.length,
                        gross: fmt(
                            partner.activities.reduce(
                                (total, a) =>
                                    total +
                                    (a.kind === "net_professional_amount"
                                        ? (a.netProfessionalIncome ?? 0)
                                        : a.grossIncome),
                                0,
                            ),
                        ),
                    }),
                )
                .join("; ");
        case "relationship":
            return t("tax.history.household.eventsSummary", {
                count: changes.relationship?.events.length ?? 0,
            });
        case "dependents":
            return t("tax.history.household.dependentsSummary", {
                children: changes.dependents?.children ?? 0,
                others: changes.dependents?.otherPersons ?? 0,
            });
        case "home":
            return t("tax.history.household.homeSummary", {
                cadastral: fmt(changes.home?.cadastralIncome ?? 0),
                interest: fmt(changes.home?.mortgageInterestPaid ?? 0),
            });
        case "region":
            return changes.region
                ? t(`tax.profile.region.${changes.region}.label`)
                : "";
        case "communalSurchargePercent":
            return `${changes.communalSurchargePercent ?? 0}%`;
        case "taxIncomeCategoryIds":
            return t("tax.history.household.categoriesSummary", {
                count: changes.taxIncomeCategoryIds?.length ?? 0,
            });
        case "profileConfigured":
            return changes.profileConfigured ? t("common.yes") : t("common.no");
    }
}

/**
 * Readable lines for a household diff: one per changed section, in a fixed order, labelled in
 * the user's language. Keys outside the known sections fall back to the compact summary.
 */
export function summarizeHouseholdChanges(
    changes: Partial<BelgianTaxHouseholdV2>,
    t: Translate,
    fmt: Format,
): string[] {
    const known = new Set<string>(HOUSEHOLD_SECTIONS);
    const lines = HOUSEHOLD_SECTIONS.filter((section) =>
        Object.hasOwn(changes, section),
    ).map(
        (section) =>
            `${t(`tax.history.household.section.${section}`)}: ${householdSectionValue(changes, section, t, fmt)}`,
    );
    // Object.fromEntries yields an index-signature record; the filtered keys are a subset of the audited change keys.
    const rest = Object.fromEntries(
        Object.entries(changes).filter(([key]) => !known.has(key)),
    ) as SnapshotAuditEntry["changes"];
    const other = summarizePatch(rest);
    return other ? [...lines, other] : lines;
}
