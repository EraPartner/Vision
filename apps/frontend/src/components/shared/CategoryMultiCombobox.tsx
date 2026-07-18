import { MultiCombobox } from "@/components/shared/MultiCombobox";
import { useCategories } from "@/hooks/useCategories";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Category } from "@/types/api";

interface CategoryMultiComboboxProps {
    value: number[];
    onChange: (ids: number[]) => void;
    disabled?: boolean;
    className?: string;
}

const getId = (cat: Category) => cat.id;
const getLabel = (cat: Category) => `${cat.general}: ${cat.detail}`;

export function CategoryMultiCombobox({ value, onChange, disabled, className }: CategoryMultiComboboxProps) {
    const { t } = useLanguage();
    const { data } = useCategories({ limit: 500, active: true });

    const displayLabel = value.length === 0
        ? t('combobox.categoryMulti.allSelected')
        : t('combobox.categoryMulti.nSelected').replace('{n}', String(value.length));

    return (
        <MultiCombobox
            value={value}
            onChange={onChange}
            items={data?.items ?? []}
            getValue={getId}
            getSearchValue={getLabel}
            renderItem={getLabel}
            displayLabel={displayLabel}
            searchPlaceholder={t('combobox.categoryMulti.search')}
            emptyText={t('combobox.categoryMulti.empty')}
            disabled={disabled}
            className={className}
        />
    );
}
