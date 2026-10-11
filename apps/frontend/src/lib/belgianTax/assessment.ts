/**
 * Assessment mode of a household for one income year (WIB 92 art. 126).
 *
 * Rule text (WIB 92, 2011 consolidation; art. 126 §2 al. 1, 4° replaced by the law of 15 July
 * 2026 art. 32 from AY 2027):
 *  - §1: marriage or legal cohabitation → joint assessment; each spouse's taxable income is
 *    still set separately.
 *  - §2 al. 1, 1°: not joint "voor het jaar van het huwelijk of de verklaring van wettelijke
 *    samenwoning"; §2 al. 2: legal cohabitants who marry stay joint in the year of the marriage
 *    "tenzij de verklaring van wettelijke samenwoning tijdens hetzelfde jaar is afgelegd".
 *  - §2 al. 1, 2°: not joint "vanaf het jaar na dat waarin de feitelijke scheiding heeft
 *    plaatsgevonden".
 *  - §2 al. 1, 3°: not joint "voor het jaar van de ontbinding van het huwelijk … of van de
 *    beëindiging van de wettelijke samenwoning".
 *  - §2 al. 1, 4°: not joint when a spouse has treaty-exempt professional income above the
 *    threshold (`treatyExemptSeparateThreshold`).
 *  - §3: for the year the marriage or legal cohabitation is dissolved by death, the survivor
 *    may elect a joint assessment.
 * Matrix rows: "Household taxation" in docs/reference/belgian-tax-rule-matrix.md.
 */

import { getTaxTable } from "./constants";
import type {
    AssessmentDecision,
    BelgianTaxHouseholdV2,
    HouseholdTaxIssue,
    PartnerId,
    RelationshipEvent,
} from "./householdTypes";

const ART_126 = "WIB 92 art. 126";

function eventYear(event: RelationshipEvent): number {
    return Number(event.date.slice(0, 4));
}

function sortEvents(events: readonly RelationshipEvent[]): RelationshipEvent[] {
    return [...events].sort((a, b) =>
        a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date),
    );
}

export interface AssessmentOutcome {
    decision: AssessmentDecision;
    issues: HouseholdTaxIssue[];
}

/**
 * Derive the assessment mode for `incomeYear` from the household's relationship events.
 * Pure and deterministic: events are ordered by date, then id.
 */
export function deriveAssessment(
    household: BelgianTaxHouseholdV2,
    incomeYear: number,
): AssessmentOutcome {
    const ids = household.partners.map((p) => p.id);
    const issues: HouseholdTaxIssue[] = [];
    const decide = (
        mode: AssessmentDecision["mode"],
        reason: AssessmentDecision["reason"],
        legalBasis: string,
        extra: { electable?: boolean; partnerIds?: PartnerId[] } = {},
    ): AssessmentOutcome => {
        const decision: AssessmentDecision = {
            mode,
            reason,
            legalBasis,
            partnerIds: extra.partnerIds ?? ids,
        };
        if (extra.electable) decision.electable = true;
        return { decision, issues };
    };

    if (household.partners.length < 2) {
        return decide("single", "one_partner", `${ART_126} §1`);
    }

    const events = sortEvents(household.relationship.events);

    // A partner who died before the income year is no longer assessed; the survivor is taxed
    // alone (the joint option of §3 covers only the year of death).
    const earlierDeath = events.find(
        (e) => e.kind === "death" && eventYear(e) < incomeYear,
    );
    if (earlierDeath) {
        const survivors = ids.filter((id) => id !== earlierDeath.partnerId);
        issues.push({
            code: "deceased_partner_not_assessed",
            severity: "info",
            ...(earlierDeath.partnerId ? { partnerId: earlierDeath.partnerId } : {}),
        });
        return decide("single", "surviving_partner", `${ART_126} §2 al. 1, 3°`, {
            partnerIds: survivors.length > 0 ? survivors : ids,
        });
    }

    if (events.length === 0) {
        if (household.relationship.legacyAssumedJoint) {
            issues.push({ code: "relationship_dates_missing", severity: "warning" });
            return withTreatyCheck(
                household,
                incomeYear,
                decide("joint", "legacy_assumed_joint", `${ART_126} §1`),
            );
        }
        return decide("separate", "no_legal_union", `${ART_126} §1`);
    }

    // Latest union start (marriage or legal cohabitation) up to the income year.
    const upToYear = events.filter((e) => eventYear(e) <= incomeYear);
    const starts = upToYear.filter(
        (e) => e.kind === "marriage" || e.kind === "legal_cohabitation",
    );
    const start = starts.at(-1);
    if (!start) {
        return decide("separate", "no_legal_union", `${ART_126} §1`);
    }

    // Dissolution of the union in force: divorce ends a marriage, the end of a legal
    // cohabitation ends a legal cohabitation, a death ends either.
    const end = upToYear.find(
        (e) =>
            e.date >= start.date &&
            (e.kind === "death" ||
                (e.kind === "divorce" && start.kind === "marriage") ||
                (e.kind === "legal_cohabitation_ended" &&
                    start.kind === "legal_cohabitation")),
    );
    if (end) {
        if (eventYear(end) < incomeYear) {
            return decide("separate", "dissolved", `${ART_126} §2 al. 1, 3°`);
        }
        if (end.kind === "death") {
            if (household.relationship.deathYearElection === "joint") {
                return decide("joint", "death_year_joint_election", `${ART_126} §3`, {
                    electable: true,
                });
            }
            return decide("separate", "death_year", `${ART_126} §2 al. 1, 3° and §3`, {
                electable: true,
            });
        }
        return decide("separate", "dissolution_year", `${ART_126} §2 al. 1, 3°`);
    }

    if (eventYear(start) === incomeYear) {
        const priorLegalCohabitation =
            start.kind === "marriage" &&
            events.some(
                (e) =>
                    e.kind === "legal_cohabitation" &&
                    eventYear(e) < incomeYear &&
                    !events.some(
                        (x) =>
                            x.kind === "legal_cohabitation_ended" &&
                            x.date >= e.date &&
                            x.date < start.date,
                    ),
            );
        if (!priorLegalCohabitation) {
            return decide("separate", "union_year", `${ART_126} §2 al. 1, 1°`);
        }
        return withTreatyCheck(
            household,
            incomeYear,
            decide(
                "joint",
                "union_year_after_legal_cohabitation",
                `${ART_126} §2 al. 2`,
            ),
        );
    }

    const separation = upToYear
        .filter((e) => e.kind === "factual_separation" && e.date >= start.date)
        .at(-1);
    if (separation && eventYear(separation) < incomeYear) {
        return decide("separate", "factually_separated", `${ART_126} §2 al. 1, 2°`);
    }

    return withTreatyCheck(
        household,
        incomeYear,
        separation
            ? decide("joint", "factual_separation_year", `${ART_126} §2 al. 1, 2°`)
            : decide("joint", "union_in_force", `${ART_126} §1`),
    );
}

/** Art. 126 §2 al. 1, 4°: treaty-exempt professional income above the threshold. */
function withTreatyCheck(
    household: BelgianTaxHouseholdV2,
    incomeYear: number,
    outcome: AssessmentOutcome,
): AssessmentOutcome {
    const threshold = getTaxTable(incomeYear).treatyExemptSeparateThreshold;
    const over = household.partners.find(
        (p) => (p.treatyExemptProfessionalIncome ?? 0) > threshold,
    );
    if (!over) return outcome;
    outcome.issues.push({
        code: "treaty_exempt_separate_assessment",
        severity: "info",
        partnerId: over.id,
    });
    return {
        decision: {
            mode: "separate",
            reason: "treaty_exempt_income",
            legalBasis: `${ART_126} §2 al. 1, 4°`,
            partnerIds: outcome.decision.partnerIds,
        },
        issues: outcome.issues,
    };
}
