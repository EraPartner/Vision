import { useState, memo } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import type { ExclusionScope } from '@/contexts/SettingsContext';
import type { Category, Recipient } from '@/types/api';

interface DashboardTabProps {
    categories: Category[];
    recipients: Recipient[];
    isLoading: boolean;
    excludedCategories: number[];
    setExcludedCategories: React.Dispatch<React.SetStateAction<number[]>>;
    excludedRecipients: number[];
    setExcludedRecipients: React.Dispatch<React.SetStateAction<number[]>>;
    excludeHidden: boolean;
    setExcludeHidden: (v: boolean) => void;
    exclusionScope: ExclusionScope;
    setExclusionScope: (scope: ExclusionScope) => void;
    includeTransfers: boolean;
    setIncludeTransfers: (v: boolean) => void;
}

export const DashboardTab = memo(function DashboardTab({
    categories,
    recipients,
    isLoading,
    excludedCategories,
    setExcludedCategories,
    excludedRecipients,
    setExcludedRecipients,
    excludeHidden,
    setExcludeHidden,
    exclusionScope,
    setExclusionScope,
    includeTransfers,
    setIncludeTransfers,
}: DashboardTabProps) {
    const { t } = useLanguage();
    const [categorySearch, setCategorySearch] = useState('');
    const [recipientSearch, setRecipientSearch] = useState('');

    const toggleCategory = (categoryId: number) => {
        setExcludedCategories((prev) =>
            prev.includes(categoryId)
                ? prev.filter((id) => id !== categoryId)
                : [...prev, categoryId]
        );
    };

    const toggleRecipient = (recipientId: number) => {
        setExcludedRecipients((prev) =>
            prev.includes(recipientId)
                ? prev.filter((id) => id !== recipientId)
                : [...prev, recipientId]
        );
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <ScrollArea className="h-full pr-4">
            <div className="space-y-6 py-4">
                {/* Exclusion Scope */}
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.exclusionScope')}</h3>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.dashboard.exclusionScopeHint')}
                    </p>
                    <Select
                        value={exclusionScope}
                        onValueChange={(v) => setExclusionScope(v as ExclusionScope)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="everywhere">{t('settings.dashboard.scope.everywhere')}</SelectItem>
                            <SelectItem value="dashboard">{t('settings.dashboard.scope.dashboard')}</SelectItem>
                            <SelectItem value="statistics">{t('settings.dashboard.scope.statistics')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <Separator />

                {/* General Settings */}
                <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.exclusionSettings')}</h3>
                    <div className="flex items-center space-x-3 rounded-lg border p-4">
                        <Checkbox
                            id="exclude-hidden"
                            checked={excludeHidden}
                            onCheckedChange={(checked) => setExcludeHidden(checked as boolean)}
                        />
                        <div className="flex-1">
                            <Label
                                htmlFor="exclude-hidden"
                                className="text-sm font-medium cursor-pointer"
                            >
                                {t('settings.dashboard.excludeHidden')}
                            </Label>
                            <p className="text-xs text-muted-foreground mt-1">
                                {t('settings.dashboard.excludeHiddenHint')}
                            </p>
                        </div>
                    </div>
                </div>

                <Separator />

                {/* Internal transfers (ADR-083) */}
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.transfersTitle')}</h3>
                    <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
                        <div className="flex-1">
                            <Label htmlFor="include-transfers" className="text-sm font-medium cursor-pointer">
                                {t('transfers.includeTransfers')}
                            </Label>
                            <p className="text-xs text-muted-foreground mt-1">
                                {t('transfers.includeTransfersHint')}
                            </p>
                        </div>
                        <Switch
                            id="include-transfers"
                            checked={includeTransfers}
                            onCheckedChange={setIncludeTransfers}
                        />
                    </div>
                </div>

                <Separator />

                {/* Categories Section */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.excludedCategories')}</h3>
                        <Badge variant="secondary" className="text-xs">
                            {excludedCategories.length} {t('settings.dashboard.excluded')}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.dashboard.excludedCategoriesHint')}
                    </p>
                    <Input
                        placeholder={t('settings.dashboard.searchCategories')}
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                        className="h-8 text-sm"
                    />
                    <ScrollArea className="h-[250px]">
                        <div className="space-y-1">
                            {categories.length === 0 ? (
                                <p className="text-sm text-muted-foreground text-center py-4">
                                    {t('settings.dashboard.noCategories')}
                                </p>
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
                                    return (
                                        <p className="text-sm text-muted-foreground text-center py-4">
                                            {t('settings.dashboard.noMatchingCategories')}
                                        </p>
                                    );
                                }

                                return Array.from(grouped.entries())
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(([general, items]) => {
                                        const allExcluded = items.every(c => excludedCategories.includes(c.id));
                                        const someExcluded = items.some(c => excludedCategories.includes(c.id));

                                        const toggleGroup = () => {
                                            if (allExcluded) {
                                                setExcludedCategories(prev =>
                                                    prev.filter(id => !items.some(c => c.id === id))
                                                );
                                            } else {
                                                setExcludedCategories(prev => {
                                                    const newIds = items.map(c => c.id).filter(id => !prev.includes(id));
                                                    return [...prev, ...newIds];
                                                });
                                            }
                                        };

                                        return (
                                            <div key={general} className="space-y-0.5">
                                                <div
                                                    className="flex items-center space-x-3 rounded-md bg-muted/50 px-3 py-2 cursor-pointer hover:bg-muted transition-colors"
                                                    onClick={toggleGroup}
                                                >
                                                    <Checkbox
                                                        checked={allExcluded ? true : someExcluded ? 'indeterminate' : false}
                                                        onCheckedChange={toggleGroup}
                                                    />
                                                    <span className="text-sm font-semibold text-foreground flex-1">{general}</span>
                                                    <span className="text-xs text-muted-foreground">{items.length}</span>
                                                </div>
                                                {items
                                                    .sort((a, b) => a.detail.localeCompare(b.detail))
                                                    .map((category) => (
                                                        <div
                                                            key={category.id}
                                                            className="flex items-center space-x-3 rounded-md border px-3 py-2 ml-6 hover:bg-accent/50 transition-colors"
                                                        >
                                                            <Checkbox
                                                                id={`category-${category.id}`}
                                                                checked={excludedCategories.includes(category.id)}
                                                                onCheckedChange={() => toggleCategory(category.id)}
                                                            />
                                                            <Label
                                                                htmlFor={`category-${category.id}`}
                                                                className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                                            >
                                                                <span>{category.detail}</span>
                                                                {!category.is_active && (
                                                                    <Badge variant="outline" className="ml-2 text-xs">
                                                                        {t('settings.dashboard.hidden')}
                                                                    </Badge>
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
                </div>

                <Separator />

                {/* Recipients Section */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground">{t('settings.dashboard.excludedRecipients')}</h3>
                        <Badge variant="secondary" className="text-xs">
                            {excludedRecipients.length} {t('settings.dashboard.excluded')}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t('settings.dashboard.excludedRecipientsHint')}
                    </p>
                    <Input
                        placeholder={t('settings.dashboard.searchRecipients')}
                        value={recipientSearch}
                        onChange={(e) => setRecipientSearch(e.target.value)}
                        className="h-8 text-sm"
                    />
                    <ScrollArea className="h-[200px]">
                        <div className="space-y-2">
                            {(() => {
                                const filtered = recipients.filter(r =>
                                    r.name.toLowerCase().includes(recipientSearch.toLowerCase())
                                );
                                if (filtered.length === 0) {
                                    return (
                                        <p className="text-sm text-muted-foreground text-center py-4">
                                            {recipientSearch ? t('settings.dashboard.noMatchingRecipients') : t('settings.dashboard.noRecipients')}
                                        </p>
                                    );
                                }
                                const sorted = [...filtered].sort((a, b) => {
                                    const aExcl = excludedRecipients.includes(a.id) ? 0 : 1;
                                    const bExcl = excludedRecipients.includes(b.id) ? 0 : 1;
                                    if (aExcl !== bExcl) return aExcl - bExcl;
                                    return a.name.localeCompare(b.name);
                                });
                                return sorted.map((recipient) => (
                                    <div
                                        key={recipient.id}
                                        className="flex items-center space-x-3 rounded-md border px-3 py-2.5 hover:bg-accent/50 transition-colors"
                                    >
                                        <Checkbox
                                            id={`recipient-${recipient.id}`}
                                            checked={excludedRecipients.includes(recipient.id)}
                                            onCheckedChange={() => toggleRecipient(recipient.id)}
                                        />
                                        <Label
                                            htmlFor={`recipient-${recipient.id}`}
                                            className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                        >
                                            <span>{recipient.name}</span>
                                            {!recipient.is_active && (
                                                <Badge variant="outline" className="ml-2 text-xs">
                                                    {t('settings.dashboard.hidden')}
                                                </Badge>
                                            )}
                                        </Label>
                                    </div>
                                ));
                            })()}
                        </div>
                    </ScrollArea>
                </div>
            </div>
        </ScrollArea>
    );
});
