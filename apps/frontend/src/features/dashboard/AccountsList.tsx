import { Link } from "react-router";
import { Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAccounts } from "@/hooks/useAccounts";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";

const MAX_ROWS = 6;

/** Home accounts list (ADR-181): active accounts with the balance and where it comes from. */
export function AccountsList() {
    const { t } = useLanguage();
    const { data } = useAccounts({ active: "true" });
    const provenance = useBalanceProvenance();
    const accounts = (data?.items ?? []).slice(0, MAX_ROWS);

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
                <CardTitle variant="sm">{t("home.accounts.title")}</CardTitle>
                <Button asChild variant="link" size="sm" className="h-auto p-0">
                    <Link to="/accounts">{t("home.accounts.showAll")}</Link>
                </Button>
            </CardHeader>
            <CardContent>
                <List>
                    {accounts.length === 0 ? (
                        <ListRow leading={<Landmark />} title={t("home.accounts.none")} />
                    ) : (
                        accounts.map((account) => {
                            const typeLabel = t(`accounts.type.${account.type}`);
                            const origin = provenance({
                                anchor_date: account.anchor_date,
                                post_anchor_count: account.post_anchor_count,
                            });
                            return (
                                <ListRow
                                    key={account.id}
                                    asChild
                                    chevron
                                    title={account.display_name || account.name}
                                    subtitle={origin ? `${typeLabel} · ${origin}` : typeLabel}
                                    trailing={
                                        account.computed_balance != null ? (
                                            <span className="font-medium text-foreground">
                                                <Money amount={account.computed_balance} currency={account.currency} />
                                            </span>
                                        ) : undefined
                                    }
                                >
                                    <Link to={`/accounts/${account.id}`} />
                                </ListRow>
                            );
                        })
                    )}
                </List>
            </CardContent>
        </Card>
    );
}
