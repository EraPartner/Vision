import { useState, useEffect } from 'react';
import { useSettings } from '@/contexts/SettingsContext';
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
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface DashboardSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function DashboardSettingsDialog({ open, onOpenChange }: DashboardSettingsDialogProps) {
    const { settings, updateSettings, resetSettings } = useSettings();
    
    // Local state for temporary changes before saving
    const [localExcludedCategories, setLocalExcludedCategories] = useState<number[]>([]);
    const [localExcludedRecipients, setLocalExcludedRecipients] = useState<number[]>([]);
    const [localExcludeHidden, setLocalExcludeHidden] = useState(true);

    // Fetch categories and recipients
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

    // Initialize local state when dialog opens
    useEffect(() => {
        if (open) {
            setLocalExcludedCategories(settings.excludedCategoryIds);
            setLocalExcludedRecipients(settings.excludedRecipientIds);
            setLocalExcludeHidden(settings.excludeHiddenCategories);
        }
    }, [open, settings]);

    const handleSave = () => {
        updateSettings({
            excludedCategoryIds: localExcludedCategories,
            excludedRecipientIds: localExcludedRecipients,
            excludeHiddenCategories: localExcludeHidden,
        });
        onOpenChange(false);
    };

    const handleReset = () => {
        resetSettings();
        setLocalExcludedCategories([]);
        setLocalExcludedRecipients([]);
        setLocalExcludeHidden(true);
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
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>Dashboard Statistics Settings</DialogTitle>
                    <DialogDescription>
                        Configure which categories and recipients should be excluded from dashboard statistics calculations.
                    </DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                ) : (
                    <ScrollArea className="flex-1 pr-4">
                        <div className="space-y-6 py-4">
                            {/* General Settings */}
                            <div className="space-y-4">
                                <h3 className="text-sm font-semibold text-foreground">General Settings</h3>
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
                                <div className="space-y-2">
                                    {recipients.length === 0 ? (
                                        <p className="text-sm text-muted-foreground text-center py-4">
                                            No recipients found
                                        </p>
                                    ) : (
                                        recipients.map((recipient) => (
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
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </ScrollArea>
                )}

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={handleReset}>
                        Reset to Defaults
                    </Button>
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
