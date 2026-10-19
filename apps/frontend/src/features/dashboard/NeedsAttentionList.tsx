import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Import, ReceiptText, Tag, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { List, ListRow } from "@/components/ui/list";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useNeedsCategoryCount } from "@/hooks/useNeedsCategoryCount";
import { usePlannedMatchSuggestions } from "@/hooks/usePlannedMatchSuggestions";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { useBankBalances } from "./useDashboardQueries";
import type { CurrencyCode } from "@vision/types/brands";

const STALE_AFTER_DAYS = 30;

type DismissedAccounts = Record<string, string>;

function readDismissedAccounts(): DismissedAccounts {
    try {
        const raw = localStorage.getItem(
            LOCAL_STORAGE_KEYS.DISMISSED_ACCOUNT_INACTIVITY,
        );
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return Object.fromEntries(
            Object.entries(parsed).filter(
                ([id, date]) =>
                    /^[1-9]\d*$/.test(id) &&
                    typeof date === "string" &&
                    /^\d{4}-\d{2}-\d{2}$/.test(date),
            ),
        );
    } catch {
        return {};
    }
}

interface NeedsAttentionListProps {
    currency: CurrencyCode;
}

/**
 * Home "Needs attention" (ADR-181): the few things that need a decision,
 * each row leading to the screen where it is settled. Empty is a result too.
 */
export function NeedsAttentionList({ currency }: NeedsAttentionListProps) {
    const { t, tc } = useLanguage();
    const { appSettings } = useAppSettings();
    const { data: needsCategory } = useNeedsCategoryCount();
    const { suggestions } = usePlannedMatchSuggestions();
    const { data: balances } = useBankBalances(currency);

    const [dismissedAccounts, setDismissedAccounts] = useState(
        readDismissedAccounts,
    );
    const persistDismissedAccounts = (next: DismissedAccounts) => {
        setDismissedAccounts(next);
        try {
            localStorage.setItem(
                LOCAL_STORAGE_KEYS.DISMISSED_ACCOUNT_INACTIVITY,
                JSON.stringify(next),
            );
        } catch {
            // When storage is unavailable, keep the choice for this mounted session.
        }
    };

    const staleAccounts = useMemo(() => {
        const accounts = balances?.accounts ?? [];
        const cutoff = Date.now() - STALE_AFTER_DAYS * 86_400_000;
        return accounts
            .filter(
                (a) =>
                    a.last_transaction &&
                    new Date(a.last_transaction).getTime() < cutoff,
            )
            .filter(
                (a) =>
                    dismissedAccounts[a.account_id] !==
                    a.last_transaction.slice(0, 10),
            )
            .slice(0, 3);
    }, [balances, dismissedAccounts]);

    const rows: React.ReactNode[] = [];
    if (needsCategory && needsCategory > 0) {
        rows.push(
            <ListRow
                key="needs-category"
                asChild
                chevron
                leading={<Tag />}
                title={tc("home.attention.needsCategory", needsCategory, {
                    count: needsCategory,
                })}
                trailing={t("home.attention.review")}
            >
                <Link to="/transactions?uncategorised=true" />
            </ListRow>,
        );
    }
    if (suggestions.length > 0) {
        rows.push(
            <ListRow
                key="looks-paid"
                asChild
                chevron
                leading={<ReceiptText />}
                title={tc("home.attention.looksPaid", suggestions.length, {
                    count: suggestions.length,
                })}
                subtitle={suggestions
                    .slice(0, 3)
                    .map((s) => s.planned.recipient_name)
                    .filter(Boolean)
                    .join(", ")}
                trailing={t("home.attention.confirm")}
            >
                <Link to="/planned" />
            </ListRow>,
        );
    }
    for (const account of staleAccounts) {
        rows.push(
            <ListRow
                key={`stale-${account.account_id}`}
                asChild
                chevron
                leading={<Import />}
                title={t("home.attention.stale", {
                    name: account.display_name || account.bank_account,
                    date: formatDateStringWithAppSettings(
                        account.last_transaction.slice(0, 10),
                        appSettings.dateFormat,
                    ),
                })}
                trailing={t("home.attention.import")}
                actions={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="icon-touch-target text-label-secondary"
                        aria-label={t("home.attention.dismissInactivity", {
                            name: account.display_name || account.bank_account,
                        })}
                        title={t("home.attention.dismissInactivity", {
                            name: account.display_name || account.bank_account,
                        })}
                        onClick={() =>
                            persistDismissedAccounts({
                                ...dismissedAccounts,
                                [account.account_id]:
                                    account.last_transaction.slice(0, 10),
                            })
                        }
                    >
                        <X aria-hidden />
                    </Button>
                }
            >
                <Link to="/import" />
            </ListRow>,
        );
    }

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle variant="sm">{t("home.attention.title")}</CardTitle>
            </CardHeader>
            <CardContent>
                <List>
                    {rows.length > 0 ? (
                        rows
                    ) : (
                        <ListRow
                            leading={<CheckCircle2 className="text-gain" />}
                            title={t("home.attention.none")}
                        />
                    )}
                </List>
                {Object.keys(dismissedAccounts).length > 0 && (
                    <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="mt-2"
                        onClick={() => persistDismissedAccounts({})}
                    >
                        {t("home.attention.restoreDismissed")}
                    </Button>
                )}
            </CardContent>
        </Card>
    );
}
