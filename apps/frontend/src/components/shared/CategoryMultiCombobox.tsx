import { MultiCombobox } from "@/components/shared/MultiCombobox";
import { useCategoryTree } from "@/hooks/useCategories";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { CategoryNode } from "@/types/api";

interface CategoryMultiComboboxProps {
    value: number[];
    onChange: (ids: number[]) => void;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
}

const getId = (cat: CategoryNode) => cat.id;
const getLabel = (cat: CategoryNode) => cat.path.join(" / ");

export function CategoryMultiCombobox({
    value,
    onChange,
    disabled,
    className,
    id,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
}: CategoryMultiComboboxProps) {
    const { t } = useLanguage();
    const { data } = useCategoryTree();
    const nodes = data?.items ?? [];
    const selectWithDescendants = (selectedIds: number[]) => {
        const expanded = new Set(selectedIds);
        for (const node of nodes) {
            if (node.pathIds.some((ancestorId) => expanded.has(ancestorId)))
                expanded.add(node.id);
        }
        onChange([...expanded].sort((a, b) => a - b));
    };

    const displayLabel =
        value.length === 0
            ? t("combobox.categoryMulti.allSelected")
            : t("combobox.categoryMulti.nSelected").replace(
                  "{n}",
                  String(value.length),
              );

    return (
        <MultiCombobox
            value={value}
            onChange={selectWithDescendants}
            items={nodes.filter((category) => category.is_active)}
            getValue={getId}
            getSearchValue={getLabel}
            renderItem={getLabel}
            displayLabel={displayLabel}
            searchPlaceholder={t("combobox.categoryMulti.search")}
            emptyText={t("combobox.categoryMulti.empty")}
            disabled={disabled}
            className={className}
            id={id}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
        />
    );
}
