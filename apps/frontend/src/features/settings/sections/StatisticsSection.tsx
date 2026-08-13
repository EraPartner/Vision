import { useState, memo } from 'react';
import { SectionLoader } from "@/components/shared/SectionLoader";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSettings, type ExclusionScope } from '@/contexts/SettingsContext';
import { apiClient } from '@/lib/api';
import { useAllCategories } from '@/hooks/useCategories';
import { recipientKeys, settingKeys } from '@/lib/queryKeys';
import { SettingsSection, SettingsGroup, SettingRow } from '../SettingsPrimitives';

export const StatisticsSection = memo(function StatisticsSection() {
    const { t } = useLanguage();
    const { settings, updateSettings } = useSettings();
    const queryClient = useQueryClient();
    const [categorySearch, setCategorySearch] = useState('');
    const [recipientSearch, setRecipientSearch] = useState('');

    // Shared with useExcludedIds' hidden-category resolution — one cache entry,
    // one request (see useAllCategories).
    const { data: categoriesData, isLoading: categoriesLoading } = useAllCategories();
    const { data: recipientsData, isLoading: recipientsLoading } = useQuery({
        queryKey: recipientKeys.allList,
        queryFn: () => apiClient.getRecipients({ limit: 1000 }),
        staleTime: 60000,
    });
    const { data: includeTransfersSetting } = useQuery({
        queryKey: settingKeys.byKey('includeTransfers'),
        queryFn: () => apiClient.getSetting('includeTransfers'),
        staleTime: 60000,
    });

    const categories = categoriesData ?? [];
    const recipients = recipientsData?.items ?? [];
    const isLoading = categoriesLoading || recipientsLoading;

    const excludedCategories = settings.excludedCategoryIds;
    const excludedRecipients = settings.excludedRecipientIds;
    const includeTransfers = includeTransfersSetting?.value === true;

    const toggleCategory = (id: number) => {
        const next = excludedCategories.includes(id)
            ? excludedCategories.filter((c) => c !== id)
            : [...excludedCategories, id];
        updateSettings({ excludedCategoryIds: next });
    };

    const toggleRecipient = (id: number) => {
        const next = excludedRecipients.includes(id)
            ? excludedRecipients.filter((r) => r !== id)
            : [...excludedRecipients, id];
        updateSettings({ excludedRecipientIds: next });
    };

    // includeTransfers is a server-only aggregation setting with no client
    // reader — persist it directly, then refetch cash-flow/aggregation data.
    const handleIncludeTransfersChange = (v: boolean) => {
        queryClient.setQueryData(settingKeys.byKey('includeTransfers'), { key: 'includeTransfers', value: v });
        apiClient.saveSetting('includeTransfers', v)
            // includeTransfers only affects server-side aggregation / cash-flow
            // outputs, so scope the refetch to those families instead of blanket-
            // invalidating every cached query (portfolio, research quotes, etc.).
            .then(() => queryClient.invalidateQueries({
                predicate: (query) => {
                    const root = query.queryKey[0];
                    if (typeof root !== 'string') return false;
                    return (
                        root === 'aggregations' ||
                        root === 'monthlySummary' ||
                        root === 'filteredDashboardStats' ||
                        root === 'dashboardRecentTransactions' ||
                        root.toLowerCase().startsWith('cashflow')
                    );
                },
            }))
            .catch(() => { /* non-fatal */ });
    };

    return (
        <SettingsSection
            title={t('settings.section.statistics')}
            description={t('settings.section.statistics.desc')}
        >
            <SettingsGroup label={t('settings.dashboard.exclusionScope')}>
                <SettingRow title={t('settings.dashboard.exclusionScope')} description={t('settings.dashboard.exclusionScopeHint')} layout="stack">
                    <Select value={settings.exclusionScope} onValueChange={(v) => updateSettings({ exclusionScope: v as ExclusionScope })}>
                        <SelectTrigger aria-label={t('settings.dashboard.exclusionScope')}><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="everywhere">{t('settings.dashboard.scope.everywhere')}</SelectItem>
                            <SelectItem value="dashboard">{t('settings.dashboard.scope.dashboard')}</SelectItem>
                            <SelectItem value="statistics">{t('settings.dashboard.scope.statistics')}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>

                <SettingRow
                    title={t('settings.dashboard.excludeHidden')}
                    description={t('settings.dashboard.excludeHiddenHint')}
                    htmlFor="exclude-hidden"
                >
                    <Switch
                        id="exclude-hidden"
                        checked={settings.excludeHiddenCategories}
                        onCheckedChange={(v) => updateSettings({ excludeHiddenCategories: v })}
                    />
                </SettingRow>

                <SettingRow
                    title={t('transfers.includeTransfers')}
                    description={t('transfers.includeTransfersHint')}
                    htmlFor="include-transfers"
                >
                    <Switch
                        id="include-transfers"
                        checked={includeTransfers}
                        onCheckedChange={handleIncludeTransfersChange}
                    />
                </SettingRow>
            </SettingsGroup>

            {isLoading ? (
                <SectionLoader />
            ) : (
                <>
                    {/* Excluded categories */}
                    <SettingsGroup label={
                        <span className="flex items-center justify-between">
                            <span>{t('settings.dashboard.excludedCategories')}</span>
                            <Badge variant="secondary" className="text-[10px] normal-case">
                                {excludedCategories.length} {t('settings.dashboard.excluded')}
                            </Badge>
                        </span>
                    }>
                        <SettingRow title={t('settings.dashboard.excludedCategoriesHint')} layout="stack">
                            <Input
                                placeholder={t('settings.dashboard.searchCategories')}
                                value={categorySearch}
                                onChange={(e) => setCategorySearch(e.target.value)}
                                className="h-8 text-sm"
                            />
                            <ScrollArea className="mt-3 h-[230px]">
                                <div className="space-y-1 pr-3">
                                    {categories.length === 0 ? (
                                        <p className="py-4 text-center text-sm text-muted-foreground">{t('settings.dashboard.noCategories')}</p>
                                    ) : (() => {
                                        const searchLower = categorySearch.toLowerCase();
                                        const grouped = new Map<string, typeof categories>();
                                        for (const cat of categories) {
                                            const matchesSearch = !categorySearch ||
                                                cat.general.toLowerCase().includes(searchLower) ||
                                                cat.detail.toLowerCase().includes(searchLower);
                                            if (!matchesSearch) continue;
                                            const group = grouped.get(cat.general) || [];
                                            group.push(cat);
                                            grouped.set(cat.general, group);
                                        }
                                        if (grouped.size === 0) {
                                            return <p className="py-4 text-center text-sm text-muted-foreground">{t('settings.dashboard.noMatchingCategories')}</p>;
                                        }
                                        return Array.from(grouped.entries())
                                            .sort(([a], [b]) => a.localeCompare(b))
                                            .map(([general, items]) => {
                                                const allExcluded = items.every((c) => excludedCategories.includes(c.id));
                                                const someExcluded = items.some((c) => excludedCategories.includes(c.id));
                                                const toggleGroup = () => {
                                                    if (allExcluded) {
                                                        updateSettings({ excludedCategoryIds: excludedCategories.filter((id) => !items.some((c) => c.id === id)) });
                                                    } else {
                                                        const newIds = items.map((c) => c.id).filter((id) => !excludedCategories.includes(id));
                                                        updateSettings({ excludedCategoryIds: [...excludedCategories, ...newIds] });
                                                    }
                                                };
                                                return (
                                                    <div key={general} className="space-y-0.5">
                                                        <div
                                                            className="flex cursor-pointer items-center space-x-3 rounded-md bg-muted/50 px-3 py-2 transition-colors hover:bg-muted"
                                                            onClick={toggleGroup}
                                                        >
                                                            <Checkbox
                                                                checked={allExcluded ? true : someExcluded ? 'indeterminate' : false}
                                                                onCheckedChange={toggleGroup}
                                                            />
                                                            <span className="flex-1 text-sm font-semibold text-foreground">{general}</span>
                                                            <span className="text-xs text-muted-foreground">{items.length}</span>
                                                        </div>
                                                        {items
                                                            .sort((a, b) => a.detail.localeCompare(b.detail))
                                                            .map((category) => (
                                                                <div key={category.id} className="ml-6 flex items-center space-x-3 rounded-md border px-3 py-2 transition-colors hover:bg-accent/50">
                                                                    <Checkbox
                                                                        id={`category-${category.id}`}
                                                                        checked={excludedCategories.includes(category.id)}
                                                                        onCheckedChange={() => toggleCategory(category.id)}
                                                                    />
                                                                    <Label htmlFor={`category-${category.id}`} className="flex flex-1 cursor-pointer items-center justify-between text-sm">
                                                                        <span>{category.detail}</span>
                                                                        {!category.is_active && (
                                                                            <Badge variant="outline" className="ml-2 text-xs">{t('settings.dashboard.hidden')}</Badge>
                                                                        )}
                                                                    </Label>
                                                                </div>
                                                            ))}
                                                    </div>
                                                );
                                            });
                                    })()}
                                </div>
                            </ScrollArea>
                        </SettingRow>
                    </SettingsGroup>

                    {/* Excluded recipients */}
                    <SettingsGroup label={
                        <span className="flex items-center justify-between">
                            <span>{t('settings.dashboard.excludedRecipients')}</span>
                            <Badge variant="secondary" className="text-[10px] normal-case">
                                {excludedRecipients.length} {t('settings.dashboard.excluded')}
                            </Badge>
                        </span>
                    }>
                        <SettingRow title={t('settings.dashboard.excludedRecipientsHint')} layout="stack">
                            <Input
                                placeholder={t('settings.dashboard.searchRecipients')}
                                value={recipientSearch}
                                onChange={(e) => setRecipientSearch(e.target.value)}
                                className="h-8 text-sm"
                            />
                            <ScrollArea className="mt-3 h-[200px]">
                                <div className="space-y-2 pr-3">
                                    {(() => {
                                        const filtered = recipients.filter((r) => r.name.toLowerCase().includes(recipientSearch.toLowerCase()));
                                        if (filtered.length === 0) {
                                            return <p className="py-4 text-center text-sm text-muted-foreground">{recipientSearch ? t('settings.dashboard.noMatchingRecipients') : t('settings.dashboard.noRecipients')}</p>;
                                        }
                                        const sorted = [...filtered].sort((a, b) => {
                                            const aExcl = excludedRecipients.includes(a.id) ? 0 : 1;
                                            const bExcl = excludedRecipients.includes(b.id) ? 0 : 1;
                                            if (aExcl !== bExcl) return aExcl - bExcl;
                                            return a.name.localeCompare(b.name);
                                        });
                                        return sorted.map((recipient) => (
                                            <div key={recipient.id} className="flex items-center space-x-3 rounded-md border px-3 py-2.5 transition-colors hover:bg-accent/50">
                                                <Checkbox
                                                    id={`recipient-${recipient.id}`}
                                                    checked={excludedRecipients.includes(recipient.id)}
                                                    onCheckedChange={() => toggleRecipient(recipient.id)}
                                                />
                                                <Label htmlFor={`recipient-${recipient.id}`} className="flex flex-1 cursor-pointer items-center justify-between text-sm">
                                                    <span>{recipient.name}</span>
                                                    {!recipient.is_active && (
                                                        <Badge variant="outline" className="ml-2 text-xs">{t('settings.dashboard.hidden')}</Badge>
                                                    )}
                                                </Label>
                                            </div>
                                        ));
                                    })()}
                                </div>
                            </ScrollArea>
                        </SettingRow>
                    </SettingsGroup>
                </>
            )}
        </SettingsSection>
    );
});
