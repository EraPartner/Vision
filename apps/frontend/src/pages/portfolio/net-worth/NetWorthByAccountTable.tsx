import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableFooter,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Money } from "@/components/shared/Money";
import { cn } from "@/lib/utils";
import type { NetWorthAccountRow } from "./netWorthByAccount";
import { sumNetWorthAccountRows } from "./netWorthByAccount";

interface Props {
    rows: readonly NetWorthAccountRow[];
    currency: string;
    headline: number;
    t: (key: string, values?: Record<string, string>) => string;
}

export function NetWorthByAccountTable({ rows, currency, headline, t }: Props) {
    const displayedTotal = sumNetWorthAccountRows(rows);
    const difference = Math.round((displayedTotal - headline) * 100) / 100;
    const matches = Math.abs(difference) < 0.005;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("networth.byAccount.title")}</CardTitle>
                <p className="text-sm text-muted-foreground">
                    {t("networth.byAccount.description")}
                </p>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>
                                {t("networth.byAccount.account")}
                            </TableHead>
                            <TableHead className="text-right">
                                {t("networth.byAccount.cash")}
                            </TableHead>
                            <TableHead className="text-right">
                                {t("networth.byAccount.holdings")}
                            </TableHead>
                            <TableHead className="text-right">
                                {t("networth.byAccount.total")}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.key}>
                                <TableCell className="font-medium">
                                    {row.label}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                    <Money
                                        amount={row.cash}
                                        currency={currency}
                                    />
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                    <Money
                                        amount={row.holdings}
                                        currency={currency}
                                    />
                                </TableCell>
                                <TableCell className="text-right font-medium tabular-nums">
                                    <Money
                                        amount={row.total}
                                        currency={currency}
                                    />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                    <TableFooter>
                        <TableRow>
                            <TableCell colSpan={3}>
                                <span className="font-semibold">
                                    {t("networth.byAccount.displayedTotal")}
                                </span>
                                <span
                                    className={cn(
                                        "ml-2 text-xs",
                                        matches
                                            ? "text-muted-foreground"
                                            : "text-warning",
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
                            </TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">
                                <Money
                                    amount={displayedTotal}
                                    currency={currency}
                                />
                            </TableCell>
                        </TableRow>
                    </TableFooter>
                </Table>
            </CardContent>
        </Card>
    );
}
