import { Activity } from 'lucide-react';
import { toggleInspector, useInspectorOpen } from '@/lib/devtools/devtoolsHotkey';
import { useApiRequestLog } from '@/lib/devtools/apiRequestLog';
import { cn } from '@/lib/utils';

export function InspectorToggle() {
    const isOpen = useInspectorOpen();
    const { inFlight } = useApiRequestLog();
    const hasPending = inFlight.length > 0;

    return (
        <button
            type="button"
            onClick={toggleInspector}
            title="Toggle API Inspector (⌘⇧A)"
            className={cn(
                'fixed bottom-4 right-4 z-[9998] flex items-center gap-1.5 rounded-full px-3 py-1.5',
                'bg-background border border-border shadow-md text-xs font-mono',
                'text-muted-foreground hover:text-foreground transition-colors',
                isOpen && 'text-primary border-primary/50',
            )}
        >
            <Activity
                className={cn(
                    'h-3.5 w-3.5',
                    hasPending && 'animate-pulse text-warning',
                    isOpen && !hasPending && 'text-primary',
                )}
            />
            <span>API</span>
            {hasPending && (
                <span className="text-warning tabular-nums">{inFlight.length}</span>
            )}
        </button>
    );
}
