import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
    Archive,
    Eye,
    FileDown,
    MoreHorizontal,
    Plus,
    Trash2,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { AssetClass, InvestmentSummary } from "@/types/portfolio";
import { AddInvestmentDialog } from "./AddInvestmentDialog";

const ImportIcon = PAGE_ICONS["/portfolio/import"];

interface FigureProps {
    label: ReactNode;
    value: ReactNode;
    detail?: ReactNode;
    tone?: string;
    icon?: LucideIcon;
    className?: string;
}

/** One secondary hero figure: caption label, title-3 value, optional footnote. */
export function Figure({
    label,
    value,
    detail,
    tone,
    icon: Icon,
    className,
}: FigureProps) {
    return (
        <div className={cn("min-w-0", className)}>
            <div className="flex items-center gap-1 type-caption text-label-tertiary">
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{label}</span>
            </div>
            <p className={cn("truncate type-title-3 tabular-nums", tone)}>
                {value}
            </p>
            {detail && (
                <div className="truncate type-footnote text-label-secondary">
                    {detail}
                </div>
            )}
        </div>
    );
}

interface FactRowProps {
    label: ReactNode;
    value: ReactNode;
    /** Optional second line under the value. */
    detail?: ReactNode;
    tone?: string;
}

/** One `dt`/`dd` line of a holding card's fact list. */
export function FactRow({ label, value, detail, tone }: FactRowProps) {
    return (
        <div className="flex items-start justify-between gap-4 py-2">
            <dt className="type-footnote text-label-secondary">{label}</dt>
            <dd className="flex flex-col items-end text-right">
                <span className={cn("type-body tabular-nums", tone)}>
                    {value}
                </span>
                {detail && (
                    <span className="type-caption tabular-nums text-label-tertiary">
                        {detail}
                    </span>
                )}
            </dd>
        </div>
    );
}

interface AssetPageActionsProps {
    allowedAssetClasses: AssetClass[];
    /** Offer the portfolio PDF export in the ••• menu. */
    showExport?: boolean;
}

/** Header actions shared by the asset pages: primary Add, ••• with export and import. */
export function AssetPageActions({
    allowedAssetClasses,
    showExport = true,
}: AssetPageActionsProps) {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [exportOpen, setExportOpen] = useState(false);
    return (
        <>
            <AddInvestmentDialog
                allowedAssetClasses={allowedAssetClasses}
                trigger={
                    <Button>
                        <Plus />
                        {t("addInv.title")}
                    </Button>
                }
            />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("portfolio.menu")}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {showExport && (
                        <>
                            <DropdownMenuItem
                                onSelect={() => setExportOpen(true)}
                            >
                                <FileDown className="mr-2 h-4 w-4 text-label-secondary" />
                                {t("portfolio.menu.exportPdf")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <DropdownMenuItem
                        onSelect={() => navigate("/portfolio/import")}
                    >
                        <ImportIcon className="mr-2 h-4 w-4 text-label-secondary" />
                        {t("nav.portfolioImport")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {showExport && (
                <ExportDialog
                    defaultType="portfolio"
                    trigger={null}
                    open={exportOpen}
                    onOpenChange={setExportOpen}
                />
            )}
        </>
    );
}

interface HoldingActionsMenuProps {
    holding: InvestmentSummary;
    deleteLabel: string;
    onDetails: (holding: InvestmentSummary) => void;
    onAddTransaction: (holding: InvestmentSummary) => void;
    onArchive: (holding: InvestmentSummary) => void;
    onDelete: (holding: InvestmentSummary) => void;
    className?: string;
}

/** Row ••• menu: details, add transaction, archive, delete. */
export function HoldingActionsMenu({
    holding,
    deleteLabel,
    onDetails,
    onAddTransaction,
    onArchive,
    onDelete,
    className,
}: HoldingActionsMenuProps) {
    const { t } = useLanguage();
    return (
        <RowMenu
            label={t("portfolio.row.menu", { name: holding.name })}
            className={className}
        >
            <DropdownMenuItem onSelect={() => onDetails(holding)}>
                <Eye className="mr-2 h-4 w-4 text-label-secondary" />
                {t("invDetail.trigger")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAddTransaction(holding)}>
                <Plus className="mr-2 h-4 w-4 text-label-secondary" />
                {t("portfolio.addTransaction")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onArchive(holding)}>
                <Archive className="mr-2 h-4 w-4 text-label-secondary" />
                {t("portfolio.archiveInvestment")}
            </DropdownMenuItem>
            <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDelete(holding)}
            >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleteLabel}
            </DropdownMenuItem>
        </RowMenu>
    );
}
