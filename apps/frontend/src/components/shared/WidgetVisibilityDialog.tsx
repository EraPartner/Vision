import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { LayoutGrid, RotateCcw } from 'lucide-react';
import type { WidgetDefinition } from '@/hooks/useWidgetVisibility';
import { useLanguage } from '@/stores/hydration/LanguageHydration';
interface WidgetVisibilityDialogProps {
    widgets: WidgetDefinition[];
    isVisible: (id: string) => boolean;
    setWidgetVisible: (id: string, visible: boolean) => void;
    setAllVisible: (visible: boolean) => void;
    resetToDefaults: () => void;
    /**
     * Controlled mode: the page owns the open state and offers its own entry
     * point (e.g. a menu item), so no trigger button is rendered.
     */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}
export function WidgetVisibilityDialog({
                                           widgets,
                                           isVisible,
                                           setWidgetVisible,
                                           setAllVisible,
                                           resetToDefaults,
                                           open,
                                           onOpenChange,
                                       }: WidgetVisibilityDialogProps) {
    const { t } = useLanguage();
    const visibleCount = widgets.filter((w) => isVisible(w.id)).length;
    const controlled = open !== undefined;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {!controlled && (
                <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                        <LayoutGrid aria-hidden="true" />
                        {t('widgets.button')}
                        <span className="type-footnote tabular-nums text-label-secondary">
                            {visibleCount}/{widgets.length}
                        </span>
                    </Button>
                </DialogTrigger>
            )}
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('widgets.title')}</DialogTitle>
                    <DialogDescription>
                        {t('widgets.description')}
                    </DialogDescription>
                </DialogHeader>
                <List className="max-h-[60vh] overflow-y-auto">
                    {widgets.map((widget) => {
                        const id = `widget-${widget.id}`;
                        return (
                            <ListRow
                                key={widget.id}
                                title={
                                    <Label htmlFor={id} className="cursor-pointer font-normal">
                                        {widget.labelKey ? t(widget.labelKey) : widget.label}
                                    </Label>
                                }
                                subtitle={widget.description}
                                trailing={
                                    <Switch
                                        id={id}
                                        checked={isVisible(widget.id)}
                                        onCheckedChange={(checked) => setWidgetVisible(widget.id, checked)}
                                    />
                                }
                            />
                        );
                    })}
                </List>
                <DialogFooter className="flex-row flex-wrap justify-between gap-2 sm:justify-between">
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setAllVisible(true)}>
                            {t('widgets.showAll')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setAllVisible(false)}>
                            {t('widgets.hideAll')}
                        </Button>
                    </div>
                    <Button variant="ghost" size="sm" onClick={resetToDefaults}>
                        <RotateCcw aria-hidden="true" />
                        {t('widgets.reset')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
