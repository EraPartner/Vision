import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { LayoutGrid, RotateCcw } from 'lucide-react';
import type { WidgetDefinition } from '@/hooks/useWidgetVisibility';
interface WidgetVisibilityDialogProps {
    widgets: WidgetDefinition[];
    isVisible: (id: string) => boolean;
    setWidgetVisible: (id: string, visible: boolean) => void;
    setAllVisible: (visible: boolean) => void;
    resetToDefaults: () => void;
}
export function WidgetVisibilityDialog({
                                           widgets,
                                           isVisible,
                                           setWidgetVisible,
                                           setAllVisible,
                                           resetToDefaults,
                                       }: WidgetVisibilityDialogProps) {
    const visibleCount = widgets.filter((w) => isVisible(w.id)).length;
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                    <LayoutGrid className="h-4 w-4" />
                    Widgets
                    <span className="text-xs text-muted-foreground">
            {visibleCount}/{widgets.length}
          </span>
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Manage Widgets</DialogTitle>
                    <DialogDescription>
                        Choose which sections to display on this page.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-1 py-2">
                    {widgets.map((widget) => (
                        <div
                            key={widget.id}
                            className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                        >
                            <div className="space-y-0.5">
                                <Label htmlFor={`widget-${widget.id}`} className="text-sm font-medium cursor-pointer">
                                    {widget.label}
                                </Label>
                                {widget.description && (
                                    <p className="text-xs text-muted-foreground">{widget.description}</p>
                                )}
                            </div>
                            <Switch
                                id={`widget-${widget.id}`}
                                checked={isVisible(widget.id)}
                                onCheckedChange={(checked) => setWidgetVisible(widget.id, checked)}
                            />
                        </div>
                    ))}
                </div>
                <Separator />
                <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setAllVisible(true)}>
                            Show All
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setAllVisible(false)}>
                            Hide All
                        </Button>
                    </div>
                    <Button variant="ghost" size="sm" className="gap-1.5" onClick={resetToDefaults}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reset
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
