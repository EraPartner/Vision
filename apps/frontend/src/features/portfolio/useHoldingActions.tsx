import { useState } from "react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { InvestmentSummary } from "@/types/portfolio";
import { AddPortfolioTxnDialog } from "./AddPortfolioTxnDialog";
import { HoldingActionsMenu } from "./assetPageParts";
import { InvestmentDetailDialog } from "./InvestmentDetailDialog";

export const toneClass = (value: number) =>
    value > 0 ? "text-gain" : value < 0 ? "text-loss" : "text-foreground";

interface UseHoldingActionsOptions {
    deleteTitleKey: string;
    /** Receives {name}. */
    deleteDescriptionKey: string;
}

/**
 * Page-level holding actions: the controlled detail and add-transaction
 * dialogs (mounted once, opened from row menus) plus confirmed archive and
 * delete. Render `dialogs` once at the page root.
 */
export function useHoldingActions({
    deleteTitleKey,
    deleteDescriptionKey,
}: UseHoldingActionsOptions) {
    const { t } = useLanguage();
    const { deleteInvestment, updateInvestment } = usePortfolio();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const [detailInvestment, setDetailInvestment] =
        useState<InvestmentSummary | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [txnInvestment, setTxnInvestment] =
        useState<InvestmentSummary | null>(null);
    const [txnOpen, setTxnOpen] = useState(false);

    const openDetail = (holding: InvestmentSummary) => {
        setDetailInvestment(holding);
        setDetailOpen(true);
    };
    const openAddTransaction = (holding: InvestmentSummary) => {
        setTxnInvestment(holding);
        setTxnOpen(true);
    };
    const archiveInvestment = async (holding: InvestmentSummary) => {
        const ok = await confirm({
            title: t("portfolio.archiveInvestment"),
            description: t("portfolio.archiveInvestmentDesc", {
                name: holding.name,
            }),
            confirmLabel: t("portfolio.archiveInvestment"),
        });
        if (ok) await updateInvestment(holding.id, { is_active: false });
    };
    const removeInvestment = async (holding: InvestmentSummary) => {
        const ok = await confirm({
            title: t(deleteTitleKey),
            description: t(deleteDescriptionKey, { name: holding.name }),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (ok) deleteInvestment(holding.id);
    };

    const dialogs = (
        <>
            {detailInvestment && (
                <InvestmentDetailDialog
                    investment={detailInvestment}
                    open={detailOpen}
                    onOpenChange={setDetailOpen}
                />
            )}
            {txnInvestment && (
                <AddPortfolioTxnDialog
                    investment={txnInvestment}
                    open={txnOpen}
                    onOpenChange={setTxnOpen}
                />
            )}
            <ConfirmDialog />
        </>
    );

    const renderMenu = (holding: InvestmentSummary, className?: string) => (
        <HoldingActionsMenu
            holding={holding}
            deleteLabel={t(deleteTitleKey)}
            onDetails={openDetail}
            onAddTransaction={openAddTransaction}
            onArchive={(h) => void archiveInvestment(h)}
            onDelete={(h) => void removeInvestment(h)}
            className={className}
        />
    );

    return { dialogs, renderMenu };
}
