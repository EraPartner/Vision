import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface FilterBannerProps {
    transactionIdFilter?: number;
    recipientIdFilter?: number;
    categoryIdFilter?: number;
    filterLabel?: string;
    onClear: () => void;
}

export function FilterBanner({
    transactionIdFilter,
    recipientIdFilter,
    categoryIdFilter,
    filterLabel,
    onClear,
}: FilterBannerProps) {
    const { t } = useLanguage();

    if (!transactionIdFilter && !recipientIdFilter && !categoryIdFilter) {
        return null;
    }

    const label =
        filterLabel ||
        (transactionIdFilter
            ? `transaction #${transactionIdFilter}`
            : recipientIdFilter
                ? `recipient #${recipientIdFilter}`
                : `category #${categoryIdFilter}`);

    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
            <span className="text-sm text-foreground">
                {t('txPage.filteredBy', { label })}
            </span>
            <Button variant="ghost" size="icon" className="icon-touch-target ml-auto" onClick={onClear}>
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}
