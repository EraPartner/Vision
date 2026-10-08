import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { List } from "@/components/ui/list";
import { Money } from "@/components/shared/Money";
import { cn } from "@/lib/utils";

export interface InvestmentTaxRow {
    id: string | number;
    name: string;
    symbol?: string;
    assetClass: string;
    recordedTaxes: number;
    recordedFees: number;
    manualTaxes: number;
    manualFees: number;
    taxes: number;
    fees: number;
    total: number;
    realizedGain: number;
    currency?: string;
}

interface InvestmentTaxBreakdownTableProps {
    investments: InvestmentTaxRow[];
    convertToTarget: (amount: number, currency?: string) => number;
    t: (key: string) => string;
}

/** Per-investment taxes and fees of the portfolio-tax page ("investmentBreakdown" widget). */
export function InvestmentTaxBreakdownTable({
    investments,
    convertToTarget,
    t,
}: InvestmentTaxBreakdownTableProps) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.widget.investmentBreakdown")}</CardTitle>
                <CardDescription>
                    {t("tax.investmentBreakdownDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <List>
                    {investments.map((inv) => (
                        <li
                            key={inv.id}
                            className="flex items-center gap-4 px-4 py-3"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate type-body font-medium text-foreground">
                                        {inv.name}
                                    </span>
                                    {inv.symbol && (
                                        <span className="font-mono type-footnote text-label-secondary">
                                            {inv.symbol}
                                        </span>
                                    )}
                                    <Badge variant="secondary" size="sm">
                                        {inv.assetClass}
                                    </Badge>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 type-footnote text-label-secondary">
                                    <span>
                                        {t("tax.taxes")}:{" "}
                                        <Money amount={inv.recordedTaxes} /> +{" "}
                                        <Money amount={inv.manualTaxes} />
                                    </span>
                                    <span>
                                        {t("tax.fees")}:{" "}
                                        <Money amount={inv.recordedFees} /> +{" "}
                                        <Money amount={inv.manualFees} />
                                    </span>
                                    {inv.realizedGain !== 0 && (
                                        <span
                                            className={cn(
                                                inv.realizedGain >= 0
                                                    ? "text-gain"
                                                    : "text-loss",
                                            )}
                                        >
                                            {t("tax.realized")}:{" "}
                                            <Money
                                                amount={convertToTarget(
                                                    inv.realizedGain,
                                                    inv.currency,
                                                )}
                                                signed
                                            />
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="shrink-0 text-right">
                                <p className="type-headline tabular-nums text-loss">
                                    <Money amount={inv.total} />
                                </p>
                                <p className="type-caption text-label-tertiary">
                                    {t("tax.totalCosts")}
                                </p>
                            </div>
                        </li>
                    ))}
                </List>
            </CardContent>
        </Card>
    );
}
