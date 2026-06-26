import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTags } from '@/hooks/useTags';
import { useLanguage } from '@/contexts/LanguageContext';

interface TagFilterComboboxProps {
    value: string[];
    onChange: (slugs: string[]) => void;
    disabled?: boolean;
    className?: string;
}

export function TagFilterCombobox({ value, onChange, disabled, className }: TagFilterComboboxProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const { data } = useTags({ is_active: true });

    const tags = data?.items ?? [];
    const selectedSet = new Set(value);

    const displayLabel = value.length === 0
        ? t('filter.tags.label')
        : t('combobox.tags.nSelected').replace('{n}', String(value.length));

    function toggle(slug: string) {
        if (selectedSet.has(slug)) {
            onChange(value.filter((s) => s !== slug));
        } else {
            onChange([...value, slug]);
        }
    }

    const sorted = [
        ...tags.filter((t) => selectedSet.has(t.slug)),
        ...tags.filter((t) => !selectedSet.has(t.slug)),
    ];

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    disabled={disabled}
                    className={cn('justify-between font-normal h-8 text-sm', className)}
                >
                    <span className="truncate">{displayLabel}</span>
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[260px] p-0 z-50" align="start">
                <Command>
                    <CommandInput placeholder={t('combobox.tags.search')} />
                    <CommandList>
                        <CommandEmpty>{t('combobox.tags.empty')}</CommandEmpty>
                        <CommandGroup>
                            {sorted.map((tag) => {
                                const selected = selectedSet.has(tag.slug);
                                const chipStyle = tag.color
                                    ? { backgroundColor: `color-mix(in srgb, ${tag.color} 14%, transparent)`, borderColor: tag.color, color: tag.color }
                                    : {};
                                return (
                                    <CommandItem
                                        key={tag.slug}
                                        value={tag.slug}
                                        onSelect={() => toggle(tag.slug)}
                                    >
                                        <Check className={cn('mr-2 h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                                        <span
                                            className="rounded-full px-2 py-0.5 text-xs border"
                                            style={chipStyle}
                                        >
                                            {tag.slug}
                                        </span>
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
