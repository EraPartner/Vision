import type { Account } from "@/types/api";
import { accountLabel } from "@/features/accounts/groupAccounts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

export const KEEP_PORTFOLIO_LOTS = "keep";
export const UNASSIGNED_PORTFOLIO_LOTS = "unassigned";

interface Props {
    sourceAccountId: number;
    accounts: readonly Account[];
    eligibleCount: number;
    value: string;
    onValueChange: (value: string) => void;
    allowKeep?: boolean;
    disabled?: boolean;
    placeholder?: string;
}

export function PortfolioLotRetagChoice({
    sourceAccountId,
    accounts,
    eligibleCount,
    value,
    onValueChange,
    allowKeep = false,
    disabled = false,
    placeholder,
}: Props) {
    const { t } = useLanguage();
    const destinations = accounts.filter(
        (account) => account.id !== sourceAccountId,
    );

    return (
        <div className="space-y-2">
            <div>
                <p className="text-sm font-medium">
                    {t("accounts.close.portfolioLots")}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t("accounts.close.portfolioLotsCount", {
                        count: String(eligibleCount),
                    })}
                </p>
            </div>
            <Select
                value={value}
                onValueChange={onValueChange}
                disabled={disabled}
            >
                <SelectTrigger
                    aria-label={t("accounts.close.portfolioDestination")}
                >
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>
                    {allowKeep && (
                        <SelectItem value={KEEP_PORTFOLIO_LOTS}>
                            {t("accounts.close.portfolioKeep")}
                        </SelectItem>
                    )}
                    <SelectItem value={UNASSIGNED_PORTFOLIO_LOTS}>
                        {t("accounts.close.portfolioUnassigned")}
                    </SelectItem>
                    {destinations.map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>
                            {accountLabel(account)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
