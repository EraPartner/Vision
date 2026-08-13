import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Info } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiClient } from '@/lib/api';
import { useState } from 'react';
import type { StepProps } from './types';

/**
 * Tax income source step.
 *
 * Lets the user mark which transaction categories count as taxable income for the
 * Tax Overview graphs. Without this, the graphs would treat every positive-amount
 * transaction (refunds, transfers, gifts) as salary and run PIT on it.
 */
export function IncomeSourcesStep({ profile, updateProfile }: StepProps) {
    const { t } = useLanguage();
    const [filter, setFilter] = useState('');

    const categoriesQuery = useQuery({
        queryKey: ['categories', 'all-for-tax-profile'],
        queryFn: async () => {
            const res = await apiClient.getCategories({ limit: 500, active: true });
            return res.items;
        },
        staleTime: 60_000,
    });

    const selected = profile.taxIncomeCategoryIds ?? [];

    const filtered = useMemo(() => {
        const categories = categoriesQuery.data ?? [];
        const q = filter.trim().toLowerCase();
        const list = categories
            .map((c) => ({
                id: c.id,
                label: `${c.general}: ${c.detail}`,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (!q) return list;
        return list.filter((c) => c.label.toLowerCase().includes(q));
    }, [categoriesQuery.data, filter]);

    function toggle(id: number) {
        const next = selected.includes(id)
            ? selected.filter((x) => x !== id)
            : [...selected, id];
        updateProfile({ taxIncomeCategoryIds: next });
    }

    function clearAll() {
        updateProfile({ taxIncomeCategoryIds: [] });
    }

    return (
        <div className="space-y-5">
            <div>
                <p className="text-sm font-semibold text-foreground mb-1">
                    {t('tax.profile.section.incomeSources.title')}
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                    {t('tax.profile.section.incomeSources.desc')}
                </p>
                <div className="flex items-start gap-2 p-3 rounded-lg border border-primary/20 bg-primary/5">
                    <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-xs text-foreground">
                        {t('tax.profile.section.incomeSources.note')}
                    </p>
                </div>
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">
                        {t('tax.profile.section.incomeSources.categoriesLabel')}{' '}
                        <Badge variant="outline" className="text-[10px] ml-1">
                            {selected.length} {t('tax.profile.section.incomeSources.selected')}
                        </Badge>
                    </Label>
                    {selected.length > 0 && (
                        <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs">
                            {t('common.clear')}
                        </Button>
                    )}
                </div>

                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                        type="text"
                        placeholder={t('tax.profile.section.incomeSources.searchPlaceholder')}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="pl-8 h-8 text-sm"
                    />
                </div>

                <Separator />

                {categoriesQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground text-center py-8">
                        {t('common.loading')}
                    </p>
                ) : filtered.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">
                        {t('tax.profile.section.incomeSources.empty')}
                    </p>
                ) : (
                    <ScrollArea className="h-[260px] pr-3">
                        <div className="space-y-1">
                            {filtered.map((c) => (
                                <label
                                    key={c.id}
                                    htmlFor={`tax-income-cat-${c.id}`}
                                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 cursor-pointer transition-colors"
                                >
                                    <Checkbox
                                        id={`tax-income-cat-${c.id}`}
                                        checked={selected.includes(c.id)}
                                        onCheckedChange={() => toggle(c.id)}
                                    />
                                    <span className="text-sm text-foreground">{c.label}</span>
                                </label>
                            ))}
                        </div>
                    </ScrollArea>
                )}
            </div>
        </div>
    );
}
