import { useMemo } from "react";
import { Link } from "react-router";
import { CheckCircle2, Import, ReceiptText, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useNeedsCategoryCount } from "@/hooks/useNeedsCategoryCount";
import { usePlannedMatchSuggestions } from "@/hooks/usePlannedMatchSuggestions";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { useBankBalances } from "./useDashboardQueries";

const STALE_AFTER_DAYS = 30;

interface NeedsAttentionListProps {
    currency: string;
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

    const staleAccounts = useMemo(() => {
        const accounts = balances?.accounts ?? [];
        const cutoff = Date.now() - STALE_AFTER_DAYS * 86_400_000;
        return accounts
            .filter((a) => a.last_transaction && new Date(a.last_transaction).getTime() < cutoff)
            .slice(0, 3);
    }, [balances]);

    const rows: React.ReactNode[] = [];
    if (needsCategory && needsCategory > 0) {
        rows.push(
            <ListRow
                key="needs-category"
                asChild
                chevron
                leading={<Tag />}
                title={tc("home.attention.needsCategory", needsCategory, { count: needsCategory })}
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
                title={tc("home.attention.looksPaid", suggestions.length, { count: suggestions.length })}
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
            </CardContent>
        </Card>
    );
}
