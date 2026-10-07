import { Link } from "react-router";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";
import type { NetWorthAccountRow } from "./netWorthByAccount";
import { sumNetWorthAccountRows } from "./netWorthByAccount";

interface Props {
    rows: readonly NetWorthAccountRow[];
    currency: string;
    headline: number;
}

/** Unassigned holdings are assigned per investment on the Portfolio page. */
const ASSIGN_HOLDINGS_ROUTE = "/portfolio";

/**
 * Current-point breakdown of net worth by account (ADR-093): one list row per
 * account that counts toward net worth, the unassigned holdings, and a closing
 * row that reconciles the displayed sum with the headline.
 */
export function NetWorthByAccountList({ rows, currency, headline }: Props) {
    const { t } = useLanguage();
    const displayedTotal = sumNetWorthAccountRows(rows);
    const difference = Math.round((displayedTotal - headline) * 100) / 100;
    const matches = Math.abs(difference) < 0.005;

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle variant="sm">{t("networth.byAccount.title")}</CardTitle>
                <CardDescription>
                    {t("networth.byAccount.description")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <List>
                    {rows.length === 0 && (
                        <ListRow title={t("networth.byAccount.none")} />
                    )}
                    {rows.map((row) => {
                        const unassigned = row.accountId == null;
                        const splitDetail =
                            Math.abs(row.cash) > 0.005 &&
                            Math.abs(row.holdings) > 0.005 ? (
                                <>
                                    {" · "}
                                    {t("networth.byAccount.cash")}{" "}
                                    <Money amount={row.cash} currency={currency} />
                                    {" · "}
                                    {t("networth.byAccount.holdings")}{" "}
                                    <Money
                                        amount={row.holdings}
                                        currency={currency}
                                    />
                                </>
                            ) : null;
                        return (
                            <ListRow
                                key={row.key}
                                title={row.label}
                                subtitle={
                                    unassigned ? (
                                        t("networth.byAccount.unassignedHint")
                                    ) : (
                                        <>
                                            {row.type
                                                ? t(`accounts.type.${row.type}`)
                                                : null}
                                            {splitDetail}
                                        </>
                                    )
                                }
                                trailing={
                                    <>
                                        {unassigned && (
                                            <Link
                                                to={ASSIGN_HOLDINGS_ROUTE}
                                                className="rounded-control type-footnote text-primary focus-ring"
                                            >
                                                {t("networth.byAccount.assign")}
                                            </Link>
                                        )}
                                        <Money
                                            amount={row.total}
                                            currency={currency}
                                            className="text-foreground"
                                        />
                                    </>
                                }
                            />
                        );
                    })}
                    <ListRow
                        className="bg-foreground/[0.02]"
                        title={
                            <span className="font-medium">
                                {t("networth.byAccount.displayedTotal")}
                            </span>
                        }
                        subtitle={
                            <span
                                className={cn(
                                    !matches && "font-medium text-warning",
                                )}
                            >
                                {matches ? (
                                    t("networth.byAccount.matches")
                                ) : (
                                    <>
                                        {t(
                                            difference > 0
                                                ? "networth.byAccount.above"
                                                : "networth.byAccount.below",
                                        )}{" "}
                                        <Money
                                            amount={Math.abs(difference)}
                                            currency={currency}
                                        />
                                    </>
                                )}
                            </span>
                        }
                        trailing={
                            <Money
                                amount={displayedTotal}
                                currency={currency}
                                className="font-medium text-foreground"
                            />
                        }
                    />
                </List>
                {!matches && (
                    <p className="max-w-prose type-footnote text-label-secondary">
                        {t("networth.byAccount.differenceHint")}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
