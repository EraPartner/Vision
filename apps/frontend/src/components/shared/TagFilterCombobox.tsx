import { MultiCombobox } from '@/components/shared/MultiCombobox';
import { useTags } from '@/hooks/useTags';
import { useLanguage } from '@/contexts/LanguageContext';
import type { Tag } from '@/types/api';

interface TagFilterComboboxProps {
    value: string[];
    onChange: (slugs: string[]) => void;
    disabled?: boolean;
    className?: string;
}

const getSlug = (tag: Tag) => tag.slug;

function renderTag(tag: Tag) {
    const chipStyle = tag.color
        ? { backgroundColor: `color-mix(in srgb, ${tag.color} 14%, transparent)`, borderColor: tag.color, color: tag.color }
        : {};
    return (
        <span
            className="rounded-full px-2 py-0.5 text-xs border"
            style={chipStyle}
        >
            {tag.slug}
        </span>
    );
}

export function TagFilterCombobox({ value, onChange, disabled, className }: TagFilterComboboxProps) {
    const { t } = useLanguage();
    const { data } = useTags({ is_active: true });

    const displayLabel = value.length === 0
        ? t('filter.tags.label')
        : t('combobox.tags.nSelected').replace('{n}', String(value.length));

    return (
        <MultiCombobox
            value={value}
            onChange={onChange}
            items={data?.items ?? []}
            getValue={getSlug}
            renderItem={renderTag}
            displayLabel={displayLabel}
            searchPlaceholder={t('combobox.tags.search')}
            emptyText={t('combobox.tags.empty')}
            popoverClassName="w-[260px]"
            disabled={disabled}
            className={className}
        />
    );
}
