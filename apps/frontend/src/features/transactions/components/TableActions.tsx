import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { AddTransactionDialog } from "@/features/transactions/components/AddTransactionDialog";

interface TableActionsProps {
    showAll: boolean;
    onToggleShowAll: () => void;
}

export function TableActions({ showAll, onToggleShowAll }: TableActionsProps) {
    const { t } = useLanguage();
    return (
        <div className="flex gap-2">
            <Button
                variant={showAll ? "secondary" : "outline"}
                size="sm"
                onClick={onToggleShowAll}
                className="gap-1.5"
            >
                {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showAll ? t('txPage.showingAll') : t('txPage.activeOnly')}
            </Button>
            <AddTransactionDialog />
        </div>
    );
}
