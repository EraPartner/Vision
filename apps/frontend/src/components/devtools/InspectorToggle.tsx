import { Activity } from 'lucide-react';
import { toggleInspector, useInspectorOpen } from '@/lib/devtools/devtoolsHotkey';
import { useApiRequestLog } from '@/lib/devtools/apiRequestLog';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function InspectorToggle() {
    const isOpen = useInspectorOpen();
    const { inFlight } = useApiRequestLog();
    const hasPending = inFlight.length > 0;

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleInspector}
            aria-pressed={isOpen}
            aria-label="Toggle API Inspector (⌘⇧A)"
            title="Toggle API Inspector (⌘⇧A)"
            className={cn(
                'fixed bottom-4 right-4 z-[9998] gap-1.5 rounded-full font-mono type-footnote shadow-elevation-2',
                'text-label-secondary hover:text-foreground',
                isOpen && 'border-primary/50 text-primary hover:text-primary',
            )}
        >
            <Activity
                aria-hidden="true"
                className={cn(
                    'size-3.5',
                    hasPending && 'animate-pulse text-warning',
                    isOpen && !hasPending && 'text-primary',
                )}
            />
            <span>API</span>
            {hasPending && (
                <span className="tabular-nums text-warning">{inFlight.length}</span>
            )}
        </Button>
    );
}
