import { useState } from "react";
import { Archive, ChevronDown, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { InvestmentSummary } from "@/types/portfolio";
import { InvestmentDetailDialog } from "./InvestmentDetailDialog";

interface Props {
    investments: readonly InvestmentSummary[];
    onRestore: (id: number) => Promise<unknown>;
    t: (key: string, params?: Record<string, string | number>) => string;
}

export function ArchivedInvestmentsCard({ investments, onRestore, t }: Props) {
    const [open, setOpen] = useState(false);
    if (investments.length === 0) return null;

    return (
        <Collapsible open={open} onOpenChange={setOpen} asChild>
            <Card>
                <CollapsibleTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        className="h-auto w-full justify-start gap-3 rounded-b-none px-6 py-4 text-left"
                    >
                        <Archive
                            className="h-4 w-4 text-label-secondary"
                            aria-hidden="true"
                        />
                        <span className="flex-1">
                            <span className="block font-medium">
                                {t("portfolio.archivedInvestments")}
                            </span>
                            <span className="block type-caption font-normal text-label-secondary">
                                {t("portfolio.archivedInvestmentsDesc")}
                            </span>
                        </span>
                        <Badge variant="secondary">{investments.length}</Badge>
                        <ChevronDown
                            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                            aria-hidden="true"
                        />
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <CardContent className="space-y-2 border-t pt-4">
                        {investments.map((investment) => (
                            <div
                                key={investment.id}
                                className="flex items-center gap-3 rounded-card corner-continuous bg-foreground/[0.04] px-3 py-2"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate type-body font-medium">
                                            {investment.name}
                                        </span>
                                        <Badge variant="outline" size="sm">
                                            {t("portfolio.archived")}
                                        </Badge>
                                    </div>
                                    <p className="type-caption text-label-secondary">
                                        {t("portfolio.archivedHistory", {
                                            count: investment.transactions
                                                .length,
                                        })}
                                    </p>
                                </div>
                                <InvestmentDetailDialog
                                    investment={investment}
                                />
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        void onRestore(investment.id)
                                    }
                                >
                                    <RotateCcw aria-hidden="true" />
                                    {t("portfolio.restoreInvestment")}
                                </Button>
                            </div>
                        ))}
                    </CardContent>
                </CollapsibleContent>
            </Card>
        </Collapsible>
    );
}
