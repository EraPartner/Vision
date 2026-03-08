import { useState, useEffect } from 'react';
import { useSettings, type ExclusionScope } from '@/contexts/SettingsContext';
import { useAppSettings, defaultAppSettings } from '@/contexts/AppSettingsContext';
import { useOnboarding } from '@/components/onboarding/OnboardingWizard';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
    Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const CURRENCIES = [
    'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK',
    'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'TRY', 'SAR', 'AED', 'INR',
    'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'NZD', 'KRW', 'THB', 'MYR', 'PHP',
];

const DATE_FORMATS = [
    { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (31/12/2024)' },
    { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (12/31/2024)' },
    { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2024-12-31)' },
    { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY (31.12.2024)' },
    { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY (31-12-2024)' },
];

const NUMBER_FORMATS = [
    { value: 'eu', label: '1.234,56 (European)' },
    { value: 'us', label: '1,234.56 (US/UK)' },
    { value: 'ch', label: "1'234.56 (Swiss)" },
    { value: 'in', label: '1,23,456.78 (Indian)' },
];

export function DashboardSettingsDialog({ open, onOpenChange }: DashboardSettingsDialogProps) {
    const { settings, updateSettings, resetSettings } = useSettings();
    const { appSettings, updateAppSettings, resetAppSettings } = useAppSettings();
    const { reset: resetOnboarding } = useOnboarding();

    // Dashboard tab local state
    const [localExcludedCategories, setLocalExcludedCategories] = useState<number[]>([]);
    const [localExcludedRecipients, setLocalExcludedRecipients] = useState<number[]>([]);
    const [localExcludeHidden, setLocalExcludeHidden] = useState(true);
    const [localExclusionScope, setLocalExclusionScope] = useState<ExclusionScope>('everywhere');
    const [recipientSearch, setRecipientSearch] = useState('');

    // General tab local state
    const [localAppSettings, setLocalAppSettings] = useState(appSettings);

    const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
        queryKey: ['categories', 'all'],
        queryFn: () => apiClient.getCategories({ limit: 1000 }),
        staleTime: 60000,
    });

    const { data: recipientsData, isLoading: recipientsLoading } = useQuery({
        queryKey: ['recipients', 'all'],
        queryFn: () => apiClient.getRecipients({ limit: 1000 }),
        staleTime: 60000,
    });

    const categories = categoriesData?.items || [];
    const recipients = recipientsData?.items || [];

    useEffect(() => {
        if (open) {
            setLocalExcludedCategories(settings.excludedCategoryIds);
            setLocalExcludedRecipients(settings.excludedRecipientIds);
            setLocalExcludeHidden(settings.excludeHiddenCategories);
            setLocalAppSettings(appSettings);
            setRecipientSearch('');
        }
    }, [open, settings, appSettings]);

    const handleSave = () => {
        updateSettings({
            excludedCategoryIds: localExcludedCategories,
            excludedRecipientIds: localExcludedRecipients,
            excludeHiddenCategories: localExcludeHidden,
        });
        updateAppSettings(localAppSettings);
        onOpenChange(false);
        toast.success('Settings saved');
    };

    const handleReset = () => {
        resetSettings();
        resetAppSettings();
        setLocalExcludedCategories([]);
        setLocalExcludedRecipients([]);
        setLocalExcludeHidden(true);
        setLocalAppSettings(defaultAppSettings);
        toast.info('Settings reset to defaults');
    };

    const handleRestartOnboarding = () => {
        resetOnboarding();
        onOpenChange(false);
        toast.success('Onboarding wizard will restart on next page load');
        // Small delay then reload to trigger onboarding
        setTimeout(() => window.location.reload(), 500);
    };

    const toggleCategory = (categoryId: number) => {
        setLocalExcludedCategories((prev) =>
            prev.includes(categoryId)
                ? prev.filter((id) => id !== categoryId)
                : [...prev, categoryId]
        );
    };

    const toggleRecipient = (recipientId: number) => {
        setLocalExcludedRecipients((prev) =>
            prev.includes(recipientId)
                ? prev.filter((id) => id !== recipientId)
                : [...prev, recipientId]
        );
    };

    const isLoading = categoriesLoading || recipientsLoading;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Configure your application preferences and dashboard statistics.
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="general" className="flex-1 flex flex-col min-h-0">
                    <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="general">General</TabsTrigger>
                        <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                        <TabsTrigger value="app">App</TabsTrigger>
                    </TabsList>

                    {/* ── General Tab ── */}
                    <TabsContent value="general" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <div className="space-y-6 py-4">
                                {/* Currency */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Default Currency</Label>
                                    <Select
                                        value={localAppSettings.defaultCurrency}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, defaultCurrency: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {CURRENCIES.map((c) => (
                                                <SelectItem key={c} value={c}>{c}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        Used as default for new transactions and display
                                    </p>
                                </div>

                                <Separator />

                                {/* Date Format */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Date Format</Label>
                                    <Select
                                        value={localAppSettings.dateFormat}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, dateFormat: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {DATE_FORMATS.map((f) => (
                                                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Number Format */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Number Format</Label>
                                    <Select
                                        value={localAppSettings.numberFormat}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, numberFormat: v })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {NUMBER_FORMATS.map((f) => (
                                                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Decimal Places */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Decimal Places</Label>
                                    <Select
                                        value={String(localAppSettings.showDecimalPlaces)}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, showDecimalPlaces: Number(v) })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="0">0 (1,234)</SelectItem>
                                            <SelectItem value="1">1 (1,234.5)</SelectItem>
                                            <SelectItem value="2">2 (1,234.56)</SelectItem>
                                            <SelectItem value="3">3 (1,234.567)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Start of Week */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Start of Week</Label>
                                    <Select
                                        value={localAppSettings.startOfWeek}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, startOfWeek: v as 'monday' | 'sunday' })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="monday">Monday</SelectItem>
                                            <SelectItem value="sunday">Sunday</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <Separator />

                                {/* Page Size */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-semibold">Default Page Size</Label>
                                    <Select
                                        value={String(localAppSettings.defaultPageSize)}
                                        onValueChange={(v) => setLocalAppSettings({ ...localAppSettings, defaultPageSize: Number(v) })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="25">25 rows</SelectItem>
                                            <SelectItem value="50">50 rows</SelectItem>
                                            <SelectItem value="100">100 rows</SelectItem>
                                            <SelectItem value="200">200 rows</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                        Number of items shown per page in tables
                                    </p>
                                </div>
                            </div>
                        </ScrollArea>
                    </TabsContent>

                    {/* ── Dashboard Tab ── */}
                    <TabsContent value="dashboard" className="flex-1 min-h-0">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            </div>
                        ) : (
                            <ScrollArea className="h-full pr-4">
                                <div className="space-y-6 py-4">
                                    {/* General Settings */}
                                    <div className="space-y-4">
                                        <h3 className="text-sm font-semibold text-foreground">Statistics Settings</h3>
                                        <div className="flex items-center space-x-3 rounded-lg border p-4">
                                            <Checkbox
                                                id="exclude-hidden"
                                                checked={localExcludeHidden}
                                                onCheckedChange={(checked) => setLocalExcludeHidden(checked as boolean)}
                                            />
                                            <div className="flex-1">
                                                <Label
                                                    htmlFor="exclude-hidden"
                                                    className="text-sm font-medium cursor-pointer"
                                                >
                                                    Exclude hidden categories from statistics
                                                </Label>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Categories marked as inactive will not be included in dashboard calculations
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <Separator />

                                    {/* Categories Section */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-semibold text-foreground">Excluded Categories</h3>
                                            <Badge variant="secondary" className="text-xs">
                                                {localExcludedCategories.length} excluded
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            Select categories to exclude from statistics
                                        </p>
                                        <div className="space-y-2">
                                            {categories.length === 0 ? (
                                                <p className="text-sm text-muted-foreground text-center py-4">
                                                    No categories found
                                                </p>
                                            ) : (
                                                categories.map((category) => (
                                                    <div
                                                        key={category.id}
                                                        className="flex items-center space-x-3 rounded-md border px-3 py-2.5 hover:bg-accent/50 transition-colors"
                                                    >
                                                        <Checkbox
                                                            id={`category-${category.id}`}
                                                            checked={localExcludedCategories.includes(category.id)}
                                                            onCheckedChange={() => toggleCategory(category.id)}
                                                        />
                                                        <Label
                                                            htmlFor={`category-${category.id}`}
                                                            className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                                        >
                                                            <span>
                                                                {category.general}
                                                                {category.detail && (
                                                                    <span className="text-muted-foreground ml-1">
                                                                        : {category.detail}
                                                                    </span>
                                                                )}
                                                            </span>
                                                            {!category.active && (
                                                                <Badge variant="outline" className="ml-2 text-xs">
                                                                    Hidden
                                                                </Badge>
                                                            )}
                                                        </Label>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>

                                    <Separator />

                                    {/* Recipients Section */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-semibold text-foreground">Excluded Recipients</h3>
                                            <Badge variant="secondary" className="text-xs">
                                                {localExcludedRecipients.length} excluded
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            Select recipients to exclude from statistics
                                        </p>
                                        <Input
                                            placeholder="Search recipients…"
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
                                                            {recipientSearch ? 'No matching recipients' : 'No recipients found'}
                                                        </p>
                                                    );
                                                }
                                                // Show excluded first, then alphabetical
                                                const sorted = [...filtered].sort((a, b) => {
                                                    const aExcl = localExcludedRecipients.includes(a.id) ? 0 : 1;
                                                    const bExcl = localExcludedRecipients.includes(b.id) ? 0 : 1;
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
                                                            checked={localExcludedRecipients.includes(recipient.id)}
                                                            onCheckedChange={() => toggleRecipient(recipient.id)}
                                                        />
                                                        <Label
                                                            htmlFor={`recipient-${recipient.id}`}
                                                            className="flex-1 text-sm cursor-pointer flex items-center justify-between"
                                                        >
                                                            <span>{recipient.name}</span>
                                                            {!recipient.active && (
                                                                <Badge variant="outline" className="ml-2 text-xs">
                                                                    Hidden
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
                        )}
                    </TabsContent>

                    {/* ── App Tab ── */}
                    <TabsContent value="app" className="flex-1 min-h-0">
                        <ScrollArea className="h-full pr-4">
                            <div className="space-y-6 py-4">
                                {/* Restart Onboarding */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">Setup Wizard</h3>
                                    <div className="flex items-center justify-between rounded-lg border p-4">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-foreground flex items-center gap-2">
                                                <Sparkles className="h-4 w-4 text-primary" />
                                                Onboarding Wizard
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Re-run the initial setup wizard to configure banks, import data, and set up categories
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleRestartOnboarding}
                                            className="ml-4 shrink-0"
                                        >
                                            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                            Restart
                                        </Button>
                                    </div>
                                </div>

                                <Separator />

                                {/* Reset All Settings */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">Reset</h3>
                                    <div className="flex items-center justify-between rounded-lg border border-destructive/20 p-4">
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-foreground">Reset All Settings</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Restore all preferences to their default values
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleReset}
                                            className="ml-4 shrink-0 text-destructive hover:text-destructive"
                                        >
                                            Reset
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave}>
                        Save Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
