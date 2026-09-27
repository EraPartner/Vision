import { ListFilterToggle } from "@/components/shared/ListFilterToggle";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { AddTransactionDialog } from "@/features/transactions/components/AddTransactionDialog";

interface TableActionsProps {
    showAll: boolean;
    onToggleShowAll: () => void;
}

export function TableActions({ showAll, onToggleShowAll }: TableActionsProps) {
    const { t } = useLanguage();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <ListFilterToggle
                checked={showAll}
                onCheckedChange={onToggleShowAll}
                label={t("common.includeInactive")}
            />
            <AddTransactionDialog />
        </div>
    );
}
