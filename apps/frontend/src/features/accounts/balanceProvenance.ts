/**
 * Balance provenance line (WP-B2, Accounts rewrite §3 F2).
 *
 * Every rendered *current* balance derives from the shared anchor+delta source
 * (the per-currency helpers in `accountBalanceSql.js`, ADR-094/118): the most recent stamped bank-statement
 * balance plus every active entry posted after it — or, when nothing is
 * stamped, a plain sum of the entries. This hook turns the payload's
 * provenance fields into the muted subline that says which of the two a figure
 * is:
 *
 *   - stamped:   "as of {date} bank statement · {n} entries since"
 *   - unstamped: "sum of {n} entries"
 *
 * Used on the Accounts hub cards, the Reconcile dialog's computed row and the
 * dashboard BankBalancesWidget cards — one helper so the wording can't drift
 * between surfaces. Returns null when the fields are absent (e.g. an Account
 * from a create/update response, which never carries the lateral's columns).
 */
import { useCallback } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";

export interface BalanceProvenanceFields {
    /** YYYY-MM-DD date of the stamped statement anchor; absent when unstamped. */
    anchor_date?: string;
    /** Entries after the anchor, or all active entries when unstamped. */
    post_anchor_count?: number;
}

/**
 * Returns a formatter mapping `{ anchor_date, post_anchor_count }` to the
 * localized provenance string, or null when the fields are absent.
 */
export function useBalanceProvenance(): (
    fields: BalanceProvenanceFields,
) => string | null {
    const { tc } = useLanguage();
    const { appSettings } = useAppSettings();

    return useCallback(
        ({
            anchor_date,
            post_anchor_count,
        }: BalanceProvenanceFields): string | null => {
            if (post_anchor_count == null) return null;
            if (anchor_date) {
                // anchor_date is a plain YYYY-MM-DD string (to_char server-side);
                // formatDateStringWithAppSettings parses it as local midnight — no
                // UTC/local day-shift (the DATE-as-ISO trap).
                return tc("accounts.provenance.anchored", post_anchor_count, {
                    date: formatDateStringWithAppSettings(
                        anchor_date,
                        appSettings.dateFormat,
                    ),
                });
            }
            return tc("accounts.provenance.sum", post_anchor_count);
        },
        [tc, appSettings.dateFormat],
    );
}
