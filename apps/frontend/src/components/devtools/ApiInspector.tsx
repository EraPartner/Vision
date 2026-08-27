import { useState, useEffect } from 'react';
import { X, Minus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApiRequestLog } from '@/lib/devtools/apiRequestLog';
import { setInspectorOpen } from '@/lib/devtools/devtoolsHotkey';
import { RequestList } from './RequestList';
import { RequestDetail } from './RequestDetail';
import { MetricsPanel } from './MetricsPanel';
import type { ApiRequestEvent } from '@/lib/devtools/apiEventBus';
import { cn } from '@/lib/utils';

export function ApiInspector() {
    const { log, inFlight } = useApiRequestLog();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [showDetail, setShowDetail] = useState(false);

    // Clear selection when log is cleared
    useEffect(() => {
        if (log.length === 0 && inFlight.length === 0) {
            setSelectedId(null);
            setShowDetail(false);
        }
    }, [log.length, inFlight.length]);

    const allEvents = [...inFlight, ...log];
    const selectedEvent = selectedId
        ? allEvents.find((e) => e.id === selectedId) ?? null
        : null;

    function handleSelect(event: ApiRequestEvent) {
        setSelectedId(event.id);
        setShowDetail(true);
    }

    const totalCount = log.length + inFlight.length;

    return (
        <div
            className="fixed bottom-14 right-4 z-[9999] flex flex-col rounded-lg border border-border bg-background shadow-2xl"
            style={{ width: 520, height: 480 }}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">API Inspector</span>
                    {inFlight.length > 0 && (
                        <Badge variant="warning" size="sm" className="px-1.5 text-2xs font-mono tabular-nums">
                            {inFlight.length} in-flight
                        </Badge>
                    )}
                    {totalCount > 0 && inFlight.length === 0 && (
                        <span className="text-2xs text-muted-foreground font-mono tabular-nums">
                            {totalCount} requests
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setInspectorOpen(false)}
                        title="Minimise"
                        className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setInspectorOpen(false)}
                        title="Close"
                        className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="flex flex-1 min-h-0">
                <Tabs defaultValue="requests" className="flex flex-col w-full">
                    <TabsList className="shrink-0 rounded-none border-b border-border h-8 bg-transparent justify-start px-2 gap-0">
                        <TabsTrigger
                            value="requests"
                            className="text-2xs h-7 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3"
                        >
                            Requests
                        </TabsTrigger>
                        <TabsTrigger
                            value="metrics"
                            className="text-2xs h-7 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3"
                        >
                            Metrics
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="requests" className="flex-1 min-h-0 mt-0 data-[state=active]:flex">
                        <div className="flex flex-1 min-h-0">
                            <div className={cn('flex flex-col min-h-0', showDetail && selectedEvent ? 'w-1/2 border-r border-border' : 'w-full')}>
                                <RequestList
                                    events={log}
                                    inFlight={inFlight}
                                    onSelect={handleSelect}
                                    selectedId={selectedId}
                                />
                            </div>
                            {showDetail && selectedEvent && (
                                <div className="flex-1 flex flex-col min-h-0">
                                    <RequestDetail
                                        event={selectedEvent}
                                        onClose={() => setShowDetail(false)}
                                    />
                                </div>
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="metrics" className="flex-1 min-h-0 mt-0 data-[state=active]:flex flex-col">
                        <MetricsPanel />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
