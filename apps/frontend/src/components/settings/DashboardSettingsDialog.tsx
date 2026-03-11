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
import { AlertCircle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
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
    const [categorySearch, setCategorySearch] = useState('');

    // General tab local state
    const [localAppSettings, setLocalAppSettings] = useState(appSettings);

    // Update tab state
    type UpdateStatus = {
        up_to_date: boolean;
        current_version: string;
        latest_version: string | null;
        published_at?: string;
        release_notes?: string;
        html_url?: string;
        error?: string;
    } | null;
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(null);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    type ApplyPhase = 'idle' | 'pulling' | 'restarting' | 'done';
    const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle');
    const applyingUpdate = applyPhase !== 'idle' && applyPhase !== 'done';

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
            setLocalExclusionScope(settings.exclusionScope);
            setLocalAppSettings(appSettings);
            setRecipientSearch('');
            setCategorySearch('');
        }
    }, [open, settings, appSettings]);

    const handleSave = () => {
        updateSettings({
            excludedCategoryIds: localExcludedCategories,
            excludedRecipientIds: localExcludedRecipients,
            excludeHiddenCategories: localExcludeHidden,
            exclusionScope: localExclusionScope,
        });
        updateAppSettings(localAppSettings);
        onOpenChange(false);
        toast.success('Settings saved');
    };

    const handleCheckForUpdates = async () => {
        setCheckingUpdate(true);
        try {
            const result = await apiClient.checkForUpdates();
            setUpdateStatus(result);
            if (result.up_to_date) {
                toast.success('App is up to date');
            } else {
                toast.info(`Update available — ${result.latest_version}`);
            }
        } catch {
            toast.error('Failed to check for updates');
        } finally {
            setCheckingUpdate(false);
        }
    };

    const handleApplyUpdate = async () => {
        setApplyPhase('pulling');
        try {
            const result = await apiClient.triggerDockerUpdate();
            if (result === null) {
                // Not running inside Electron — shouldn't happen since the button is
                // only shown in Electron, but guard anyway.
                toast.info('Updates are applied automatically when the app restarts.');
                setApplyPhase('idle');
                return;
            }
            if (!result.success) {
                toast.error('Update failed', { description: result.error });
                setApplyPhase('idle');
                return;
            }
            if (!result.wasNew) {
                toast.success('Already on the latest version');
                setUpdateStatus((prev) => prev ? { ...prev, up_to_date: true } : null);
                setApplyPhase('done');
                return;
            }
            // Container was replaced with the new image; migrations ran via entrypoint.
            // Poll /api/admin/update/check until the new version is reported.
            setApplyPhase('restarting');
            toast.success('New image pulled — waiting for the app to restart…', { duration: 10000 });
            const poll = async (attempts: number) => {
                try {
                    const status = await apiClient.checkForUpdates();
                    setUpdateStatus(status);
                    setApplyPhase('done');
                    toast.success('Update complete', { description: `Now running ${status.current_version}` });
                } catch {
                    if (attempts > 0) setTimeout(() => poll(attempts - 1), 2000);
                    else {
                        setApplyPhase('done');
                        toast.info('App restarted. You may need to reload the page.');
                    }
                }
            };
            setTimeout(() => poll(20), 3000);
        } catch (err: unknown) {
            const msg = (err as { message?: string })?.message ?? 'Update failed';
            toast.error(msg);
            setApplyPhase('idle');
        }
    };

    const handleReset = () => {
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
                                    {/* Exclusion Scope */}
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold text-foreground">Exclusion Scope</h3>
                                        <p className="text-xs text-muted-foreground">
                                            Choose where category and recipient exclusions are applied
                                        </p>
                                        <Select
                                            value={localExclusionScope}
                                            onValueChange={(v) => setLocalExclusionScope(v as ExclusionScope)}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="everywhere">Everywhere (Dashboard + Statistics)</SelectItem>
                                                <SelectItem value="dashboard">Dashboard only</SelectItem>
                                                <SelectItem value="statistics">Statistics only</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <Separator />

                                    {/* General Settings */}
                                    <div className="space-y-4">
                                        <h3 className="text-sm font-semibold text-foreground">Exclusion Settings</h3>
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
                                                    Exclude hidden categories
                                                </Label>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Categories marked as inactive will be excluded based on the scope above
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
                                        <Input
                                            placeholder="Search categories…"
                                            value={categorySearch}
                                            onChange={(e) => setCategorySearch(e.target.value)}
                                            className="h-8 text-sm"
                                        />
                                        <ScrollArea className="h-[250px]">
                                            <div className="space-y-1">
                                                {categories.length === 0 ? (
                                                    <p className="text-sm text-muted-foreground text-center py-4">
                                                        No categories found
                                                    </p>
                                                ) : (() => {
                                                    // Group by general, filter by search
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
                                                                No matching categories
                                                            </p>
                                                        );
                                                    }

                                                    return Array.from(grouped.entries())
                                                        .sort(([a], [b]) => a.localeCompare(b))
                                                        .map(([general, items]) => {
                                                            const allExcluded = items.every(c => localExcludedCategories.includes(c.id));
                                                            const someExcluded = items.some(c => localExcludedCategories.includes(c.id));

                                                            const toggleGroup = () => {
                                                                if (allExcluded) {
                                                                    // Remove all in group
                                                                    setLocalExcludedCategories(prev =>
                                                                        prev.filter(id => !items.some(c => c.id === id))
                                                                    );
                                                                } else {
                                                                    // Add all in group
                                                                    setLocalExcludedCategories(prev => {
                                                                        const newIds = items.map(c => c.id).filter(id => !prev.includes(id));
                                                                        return [...prev, ...newIds];
                                                                    });
                                                                }
                                                            };

                                                            return (
                                                                <div key={general} className="space-y-0.5">
                                                                    {/* Group header */}
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
                                                                    {/* Detail items */}
                                                                    {items
                                                                        .sort((a, b) => a.detail.localeCompare(b.detail))
                                                                        .map((category) => (
                                                                            <div
                                                                                key={category.id}
                                                                                className="flex items-center space-x-3 rounded-md border px-3 py-2 ml-6 hover:bg-accent/50 transition-colors"
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
                                                                                    <span>{category.detail}</span>
                                                                                    {!category.active && (
                                                                                        <Badge variant="outline" className="ml-2 text-xs">
                                                                                            Hidden
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

                                {/* App Updates */}
                                <div className="space-y-3">
                                    <h3 className="text-sm font-semibold text-foreground">App Updates</h3>
                                    <p className="text-xs text-muted-foreground">
                                        {apiClient.isElectron()
                                            ? 'Check for a new release and pull the latest Docker image. Database migrations run automatically on restart.'
                                            : 'Updates are applied automatically when the desktop app restarts.'}
                                    </p>

                                    {/* Status banner */}
                                    {updateStatus && (
                                        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                                            updateStatus.up_to_date
                                                ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400'
                                                : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400'
                                        }`}>
                                            {updateStatus.up_to_date
                                                ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                                                : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                            }
                                            <div className="flex-1 min-w-0">
                                                {updateStatus.up_to_date ? (
                                                    <p>Running the latest version{updateStatus.current_version ? ` (${updateStatus.current_version})` : ''}.</p>
                                                ) : (
                                                    <>
                                                        <p className="font-medium">
                                                            Version {updateStatus.latest_version} is available
                                                            {updateStatus.current_version ? ` (current: ${updateStatus.current_version})` : ''}.
                                                        </p>
                                                        {updateStatus.published_at && (
                                                            <p className="text-xs mt-0.5 opacity-80">
                                                                Released {new Date(updateStatus.published_at).toLocaleDateString()}
                                                            </p>
                                                        )}
                                                        {updateStatus.release_notes && (
                                                            <p className="text-xs mt-1 opacity-80 line-clamp-2">{updateStatus.release_notes}</p>
                                                        )}
                                                    </>
                                                )}
                                                {updateStatus.error && (
                                                    <p className="text-xs mt-0.5 opacity-80">{updateStatus.error}</p>
                                                )}
                                            </div>
                                            {updateStatus.html_url && (
                                                <a
                                                    href={updateStatus.html_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
                                                    title="View release notes"
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                            )}
                                        </div>
                                    )}

                                    {/* Phase indicator while updating */}
                                    {(applyPhase === 'pulling' || applyPhase === 'restarting') && (
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            {applyPhase === 'pulling' ? 'Pulling latest image…' : 'Waiting for app to restart…'}
                                        </div>
                                    )}

                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleCheckForUpdates}
                                            disabled={checkingUpdate || applyingUpdate}
                                        >
                                            {checkingUpdate
                                                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                                            }
                                            Check for updates
                                        </Button>

                                        {/* Only shown inside Electron when an update is available */}
                                        {apiClient.isElectron() && updateStatus && !updateStatus.up_to_date && (
                                            <Button
                                                size="sm"
                                                onClick={handleApplyUpdate}
                                                disabled={applyingUpdate || checkingUpdate}
                                            >
                                                {applyingUpdate
                                                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    : <Download className="h-3.5 w-3.5 mr-1.5" />
                                                }
                                                {applyPhase === 'restarting' ? 'Restarting…' : 'Install update'}
                                            </Button>
                                        )}
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
