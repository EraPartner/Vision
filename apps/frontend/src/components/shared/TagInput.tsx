import { useState, useRef, useCallback, useMemo } from 'react';
import { X, Plus, Tag as TagIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { useTags, useCreateTag } from '@/hooks/useTags';
import { useLanguage } from '@/contexts/LanguageContext';
import { slugify } from '@/lib/slugify';
import type { Tag } from '@/types/api';

// Jewel-tone palette spanning the hue wheel (matches the app's jewel accent).
const PALETTE: string[] = [
    'hsl(355, 60%, 52%)', // crimson
    'hsl(20, 68%, 52%)',  // coral
    'hsl(40, 64%, 50%)',  // amber
    'hsl(52, 62%, 46%)',  // gold
    'hsl(96, 42%, 42%)',  // moss
    'hsl(150, 50%, 38%)', // emerald
    'hsl(174, 50%, 40%)', // teal
    'hsl(192, 58%, 44%)', // cyan
    'hsl(210, 62%, 50%)', // azure
    'hsl(244, 46%, 58%)', // indigo
    'hsl(280, 46%, 56%)', // violet
    'hsl(322, 54%, 54%)', // magenta
];

// Human-readable names for each palette swatch, keyed by its hsl() string, so
// swatch buttons get a meaningful aria-label instead of raw CSS colour syntax.
const PALETTE_NAMES: Record<string, string> = {
    'hsl(355, 60%, 52%)': 'crimson',
    'hsl(20, 68%, 52%)': 'coral',
    'hsl(40, 64%, 50%)': 'amber',
    'hsl(52, 62%, 46%)': 'gold',
    'hsl(96, 42%, 42%)': 'moss',
    'hsl(150, 50%, 38%)': 'emerald',
    'hsl(174, 50%, 40%)': 'teal',
    'hsl(192, 58%, 44%)': 'cyan',
    'hsl(210, 62%, 50%)': 'azure',
    'hsl(244, 46%, 58%)': 'indigo',
    'hsl(280, 46%, 56%)': 'violet',
    'hsl(322, 54%, 54%)': 'magenta',
};

// Pick a random palette colour so new tags aren't all the first (green) swatch.
function randomPaletteColor(): string {
    return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

// A translucent fill of the tag colour. color-mix works for any colour syntax
// (hsl()/hex); the old `color + '22'` produced invalid CSS for hsl() values.
function tagChipStyle(color: string | null): React.CSSProperties {
    if (!color) return {};
    return {
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderColor: color,
        color,
    };
}

export interface TagChipProps {
    tag: Tag;
    onRemove?: (slug: string) => void;
    inactive?: boolean;
}

export function TagChip({ tag, onRemove, inactive }: TagChipProps) {
    const style = tagChipStyle(tag.color);
    return (
        <Badge
            variant="outline"
            className={cn('gap-1 text-xs py-0.5 px-2 font-normal', inactive && 'opacity-40')}
            style={style}
        >
            {tag.slug}
            {onRemove && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRemove(tag.slug); }}
                    className="ml-0.5 hover:opacity-70 focus:outline-none"
                    aria-label={`Remove tag ${tag.slug}`}
                >
                    <X className="h-3 w-3" />
                </button>
            )}
        </Badge>
    );
}

interface TagInputProps {
    value: string[];
    onChange: (slugs: string[]) => void;
    disabled?: boolean;
    className?: string;
    maxTags?: number;
}

export function TagInput({ value, onChange, disabled, className, maxTags = 20 }: TagInputProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [pendingColor, setPendingColor] = useState<string>(randomPaletteColor);
    const inputRef = useRef<HTMLInputElement>(null);

    const { data: tagListData } = useTags({ is_active: true });
    const allActiveTags = useMemo(() => tagListData?.items ?? [], [tagListData?.items]);

    const createTag = useCreateTag();

    const selectedSet = useMemo(() => new Set(value), [value]);
    const tagsBySlug = useMemo(
        () => new Map(allActiveTags.map((tag) => [tag.slug, tag])),
        [allActiveTags],
    );
    const liveSlug = useMemo(() => slugify(inputValue), [inputValue]);

    const suggestions = useMemo(
        () => allActiveTags.filter((tag) =>
            !selectedSet.has(tag.slug) &&
            (inputValue === '' || tag.slug.includes(liveSlug)),
        ),
        [allActiveTags, selectedSet, inputValue, liveSlug],
    );
    const exactMatch = useMemo(() => tagsBySlug.get(liveSlug), [tagsBySlug, liveSlug]);
    const canCreate = liveSlug.length > 0 && !exactMatch && value.length < maxTags;

    const addSlug = useCallback((slug: string) => {
        if (!slug || value.includes(slug) || value.length >= maxTags) return;
        onChange([...value, slug]);
    }, [value, onChange, maxTags]);

    const removeSlug = useCallback((slug: string) => {
        onChange(value.filter((s) => s !== slug));
    }, [value, onChange]);

    async function handleCreate() {
        if (!canCreate) return;
        const slug = liveSlug;
        try {
            await createTag.mutateAsync({ slug, color: pendingColor });
        } catch {
            // tag may already exist (race); addSlug proceeds regardless
        }
        addSlug(slug);
        setInputValue('');
        setPendingColor(randomPaletteColor());
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if ((e.key === 'Enter' || e.key === ',') && liveSlug) {
            e.preventDefault();
            if (exactMatch) {
                addSlug(exactMatch.slug);
                setInputValue('');
            } else if (canCreate) {
                handleCreate();
            }
        }
        if (e.key === 'Backspace' && inputValue === '' && value.length > 0) {
            removeSlug(value[value.length - 1]);
        }
    }

    const selectedTags = useMemo(
        () => value.map((slug): Tag =>
            tagsBySlug.get(slug) ?? { id: -1, slug, color: null, is_active: true, created_at: '', updated_at: '' },
        ),
        [value, tagsBySlug],
    );

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <div
                    role="combobox"
                    aria-expanded={open}
                    tabIndex={disabled ? -1 : 0}
                    className={cn(
                        'flex flex-wrap gap-1 items-center min-h-9 px-3 py-1.5 rounded-md border border-input bg-background text-sm cursor-text',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2',
                        disabled && 'opacity-50 pointer-events-none',
                        className,
                    )}
                    onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpen(true);
                            setTimeout(() => inputRef.current?.focus(), 0);
                        }
                    }}
                >
                    {selectedTags.map((tag) => (
                        <TagChip key={tag.slug} tag={tag} onRemove={disabled ? undefined : removeSlug} />
                    ))}
                    {!disabled && value.length < maxTags && (
                        <TagIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                </div>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0 z-50" align="start">
                <Command shouldFilter={false}>
                    <CommandInput
                        ref={inputRef}
                        placeholder={t('tags.searchPlaceholder')}
                        value={inputValue}
                        onValueChange={setInputValue}
                        onKeyDown={handleKeyDown}
                    />
                    {liveSlug && liveSlug !== inputValue.trim() && (
                        <p className="px-3 py-1 text-xs text-muted-foreground">
                            {t('tags.slugifyHint').replace('{{slug}}', liveSlug)}
                        </p>
                    )}
                    <CommandList>
                        {suggestions.length === 0 && !canCreate && (
                            <CommandEmpty>{t('tags.empty')}</CommandEmpty>
                        )}
                        {suggestions.length > 0 && (
                            <CommandGroup>
                                {suggestions.map((tag) => (
                                    <CommandItem
                                        key={tag.slug}
                                        value={tag.slug}
                                        onSelect={() => { addSlug(tag.slug); setInputValue(''); }}
                                        className={cn(!tag.is_active && 'opacity-40')}
                                    >
                                        <TagChip tag={tag} inactive={!tag.is_active} />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                        {canCreate && (
                            <CommandGroup>
                                <CommandItem value={`__create__${liveSlug}`} onSelect={handleCreate}>
                                    <div className="flex items-center gap-2 w-full">
                                        <Plus className="h-3.5 w-3.5 shrink-0" />
                                        <span className="flex-1 text-sm">
                                            {t('tags.create').replace("'{{slug}}'", `'${liveSlug}'`)}
                                        </span>
                                        <div className="flex gap-1">
                                            {PALETTE.map((color) => (
                                                <button
                                                    key={color}
                                                    type="button"
                                                    className={cn(
                                                        'h-4 w-4 rounded-full border-2 shrink-0',
                                                        pendingColor === color ? 'border-foreground' : 'border-transparent',
                                                    )}
                                                    style={{ backgroundColor: color }}
                                                    onClick={(e) => { e.stopPropagation(); setPendingColor(color); }}
                                                    aria-label={PALETTE_NAMES[color] ?? 'tag color'}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </CommandItem>
                            </CommandGroup>
                        )}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
