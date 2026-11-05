import type {
    ClassifiableHolding,
    ClassificationChanges,
} from "@/lib/api/portfolioExposure";
import type { InvestmentId } from "@vision/types/brands";

/** One row of the Classify holdings sheet as the user is editing it. */
export type Draft = { issuerName: string; sector: string; country: string };

export const draftOf = (holding: ClassifiableHolding): Draft => ({
    issuerName: holding.classification?.issuerName ?? "",
    sector: holding.classification?.sector ?? "",
    country: holding.classification?.issuerCountryCode ?? "",
});
export const sameDraft = (a: Draft, b: Draft) =>
    a.issuerName.trim() === b.issuerName.trim() &&
    a.sector.trim() === b.sector.trim() &&
    a.country === b.country;
export const isEmptyDraft = (draft: Draft) =>
    !draft.issuerName.trim() && !draft.sector.trim() && !draft.country;

/**
 * Turn edited rows into the PUT body: a row with values is set (issuer falls
 * back to the holding name), an emptied row that had a classification is
 * cleared, and an untouched row is left out.
 */
export function classificationChanges(
    holdings: readonly ClassifiableHolding[],
    drafts: ReadonlyMap<InvestmentId, Draft>,
): ClassificationChanges {
    const changes: ClassificationChanges = { set: [], clear: [] };
    for (const holding of holdings) {
        const draft = drafts.get(holding.investmentId);
        if (!draft || sameDraft(draft, draftOf(holding))) continue;
        if (isEmptyDraft(draft)) {
            if (holding.classification)
                changes.clear.push(holding.investmentId);
            continue;
        }
        const sector = draft.sector.trim();
        changes.set.push({
            investmentId: holding.investmentId,
            issuerName: draft.issuerName.trim() || holding.name,
            ...(sector ? { sector } : {}),
            ...(draft.country ? { issuerCountryCode: draft.country } : {}),
        });
    }
    return changes;
}
