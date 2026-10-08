import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ApiRequestEvent } from '@/lib/devtools/apiEventBus';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface Props {
    events: ApiRequestEvent[];
    inFlight: ApiRequestEvent[];
    onSelect: (event: ApiRequestEvent) => void;
    selectedId: string | null;
}

const METHOD_COLOR: Record<string, string> = {
    GET: 'text-info',
    POST: 'text-success',
    PUT: 'text-warning',
    PATCH: 'text-warning',
    DELETE: 'text-destructive',
};

function RequestRow({
    event,
    isSelected,
    isInFlight,
    onClick,
}: {
    event: ApiRequestEvent;
    isSelected: boolean;
    isInFlight: boolean;
    onClick: () => void;
}) {
    const isError = event.phase === 'error';
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={isSelected}
            className={cn(
                'flex h-full w-full items-center gap-2 px-3 py-1.5 text-left',
                'transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04] focus-ring focus-visible:outline-offset-[-3px]',
                isSelected && 'bg-primary/[0.08]',
            )}
        >
            <span
                className={cn(
                    'w-14 shrink-0 font-mono type-caption font-medium',
                    METHOD_COLOR[event.method] ?? 'text-label-secondary',
                )}
            >
                {event.method}
            </span>
            <span
                className={cn(
                    'flex-1 truncate font-mono type-caption',
                    isError ? 'text-destructive' : 'text-foreground',
                )}
            >
                {event.endpoint}
            </span>
            {isInFlight ? (
                <span className="shrink-0 animate-pulse type-caption text-warning">…</span>
            ) : (
                <>
                    {event.status && (
                        <span
                            className={cn(
                                'shrink-0 font-mono type-caption tabular-nums',
                                isError ? 'text-destructive' : 'text-success',
                            )}
                        >
                            {event.status}
                        </span>
                    )}
                    {event.durationMs !== undefined && (
                        <span
                            className={cn(
                                'shrink-0 type-caption tabular-nums',
                                event.durationMs >= 1000 ? 'text-warning' : 'text-label-secondary',
                            )}
                        >
                            {event.durationMs < 1000
                                ? `${event.durationMs.toFixed(0)}ms`
                                : `${(event.durationMs / 1000).toFixed(2)}s`}
                        </span>
                    )}
                </>
            )}
        </button>
    );
}

export function RequestList({ events, inFlight, onSelect, selectedId }: Props) {
    const parentRef = useRef<HTMLDivElement>(null);
    const [filter, setFilter] = useState('');

    const inFlightIds = new Set(inFlight.map((e) => e.id));
    const combined: ApiRequestEvent[] = [
        ...inFlight,
        ...events.filter((e) => !inFlightIds.has(e.id)),
    ];

    const filtered = filter
        ? combined.filter(
              (e) =>
                  e.endpoint.toLowerCase().includes(filter.toLowerCase()) ||
                  e.method.toLowerCase().includes(filter.toLowerCase()),
          )
        : combined;

    const rowVirtualizer = useVirtualizer({
        count: filtered.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 30,
        overscan: 10,
    });

    return (
        <div className="flex flex-col h-full">
            <div className="px-2 py-1.5 border-b border-border shrink-0">
                <Input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter by endpoint or method…"
                    aria-label="Filter by endpoint or method"
                    className="h-8 font-mono type-footnote"
                />
            </div>
            {filtered.length === 0 ? (
                <div className="flex flex-1 items-center justify-center type-footnote text-label-secondary">
                    No requests yet
                </div>
            ) : (
                <div ref={parentRef} className="flex-1 overflow-auto">
                    <div
                        style={{ height: rowVirtualizer.getTotalSize() }}
                        className="relative"
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const event = filtered[virtualRow.index]!;
                            return (
                                <div
                                    key={`${event.id}-${event.phase}`}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: virtualRow.size,
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <RequestRow
                                        event={event}
                                        isSelected={selectedId === event.id}
                                        isInFlight={inFlightIds.has(event.id)}
                                        onClick={() => onSelect(event)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
