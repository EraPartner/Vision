/**
 * Belgian tax — attribution of transaction-derived figures to the partners of a household
 * (ADR-201, superseding ADR-200 §7 for the mapping).
 *
 * The mapping is fixed: account owner `me` is partner A, `partner` is partner B and `joint`
 * accounts are split 50/50. A transaction without an account counts as `me`. Without partner B
 * every amount goes to partner A unchanged, so a single-person household keeps its figures.
 *
 * Kept out of the `@/lib/belgianTax` barrel: import it by file path.
 */

import { applyProfileV1PatchToHousehold } from "./householdMigration.ts";
import type {
  BelgianTaxHouseholdV2,
  HouseholdPartner,
  PartnerId,
} from "./householdTypes.ts";

/** `accounts.owner` values. */
export type AccountOwner = "me" | "partner" | "joint";

/** Amounts per account owner; a missing owner counts as 0. */
export type OwnerAmounts = Partial<Record<AccountOwner, number>>;

/** Amounts per partner; `B` is 0 when the household has no partner B. */
export type PartnerAmounts = Record<PartnerId, number>;

const cents = (value: number) => Math.round(value * 100) / 100;

export function householdHasPartnerB(
  household: Pick<BelgianTaxHouseholdV2, "partners"> | null | undefined,
): boolean {
  return household?.partners.some((p) => p.id === "B") ?? false;
}

/**
 * Partner B's share of the owner amounts: the `partner` amount plus half of the `joint` one,
 * rounded to cents. 0 without partner B.
 */
export function partnerBShare(
  byOwner: OwnerAmounts | undefined,
  hasPartnerB: boolean,
): number {
  if (!hasPartnerB || !byOwner) return 0;
  return cents((byOwner.partner ?? 0) + (byOwner.joint ?? 0) / 2);
}

/**
 * Split `total` between the partners. Partner A receives the total minus partner B's share, so
 * the two shares always add up to `total`; without partner B, A receives `total` unchanged.
 */
export function attributeToPartners(
  total: number,
  byOwner: OwnerAmounts | undefined,
  hasPartnerB: boolean,
): PartnerAmounts {
  const b = partnerBShare(byOwner, hasPartnerB);
  if (b === 0) return { A: total, B: 0 };
  return { A: cents(total - b), B: b };
}

/** The activity that receives a partner's recorded income: the first one with a gross figure. */
function grossActivity(partner: HouseholdPartner) {
  return partner.activities.find((a) => a.kind !== "net_professional_amount");
}

/**
 * Household whose partners earn the recorded income `total`, of which `partnerB` belongs to
 * partner B, for a what-if estimate (the yearly chart and the monthly reserve). Partner A's share
 * goes to A's primary activity exactly as a v1 `grossAnnualIncome` patch would, and B's share
 * replaces the gross of B's first activity that carries a gross figure. Returns `undefined` when
 * B has no such activity (for example a migrated spouse with only a net amount): the caller then
 * keeps the whole total on partner A, as before attribution existed.
 */
export function householdWithRecordedIncome(
  household: BelgianTaxHouseholdV2,
  total: number,
  partnerB: number,
): BelgianTaxHouseholdV2 | undefined {
  const b = household.partners.find((p) => p.id === "B");
  if (!b || !grossActivity(b)) return undefined;
  // A `grossAnnualIncome` patch never reads the filing status, so no joint-filing check is
  // needed (and the browser bundle, which also uses this module, stays without the assessment).
  const next = applyProfileV1PatchToHousehold(
    household,
    { grossAnnualIncome: Math.max(0, cents(total - partnerB)) },
    undefined,
  );
  const target = next.partners.find((p) => p.id === "B");
  const activity = target && grossActivity(target);
  if (activity) activity.grossIncome = Math.max(0, partnerB);
  return next;
}

/** True when any of the owner amounts was booked on a `partner` or `joint` account. */
export function hasPartnerOrJointAmounts(
  byOwner: OwnerAmounts | undefined,
): boolean {
  return (byOwner?.partner ?? 0) !== 0 || (byOwner?.joint ?? 0) !== 0;
}

/**
 * Household to estimate the recorded income `total` with (ADR-201), or `undefined` to keep the
 * pre-attribution behaviour (the whole total on partner A, partner B's entered gross unchanged).
 * The gate is whether any of the income was recorded on a `partner` or `joint` account, not B's
 * share alone: once such income exists, B is taxed on their recorded share even when it rounds
 * to 0, so the estimate does not jump between B's entered gross and the recorded share. Users
 * who never set account owners have no such income and keep their figures.
 */
export function householdForRecordedIncome(
  household: BelgianTaxHouseholdV2 | null | undefined,
  total: number,
  byOwner: OwnerAmounts | undefined,
): BelgianTaxHouseholdV2 | undefined {
  if (!household || !hasPartnerOrJointAmounts(byOwner)) return undefined;
  if (!householdHasPartnerB(household)) return undefined;
  return householdWithRecordedIncome(
    household,
    total,
    partnerBShare(byOwner, true),
  );
}
