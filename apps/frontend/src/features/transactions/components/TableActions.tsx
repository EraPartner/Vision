import { ListFilterToggle } from "@/components/shared/ListFilterToggle";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { AddTransactionButton } from "@/features/transactions/components/AddTransactionSheet";

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
            <AddTransactionButton />
        </div>
    );
}
