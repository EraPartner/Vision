import { X } from 'lucide-react';
import type { ApiRequestEvent } from '@/lib/devtools/apiEventBus';
import { cn } from '@/lib/utils';

interface Props {
    event: ApiRequestEvent;
    onClose: () => void;
}

function StatusBadge({ status }: { status?: number }) {
    if (!status) return <span className="text-muted-foreground">—</span>;
    const cls =
        status < 300
            ? 'text-success'
            : status < 400
            ? 'text-warning'
            : 'text-destructive';
    return <span className={cn('font-mono font-semibold', cls)}>{status}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0">
            <span className="w-28 shrink-0 text-muted-foreground text-xs">{label}</span>
            <span className="flex-1 font-mono text-xs break-all">{children}</span>
        </div>
    );
}

export function RequestDetail({ event, onClose }: Props) {
    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <span className="text-xs font-semibold text-foreground">Request detail</span>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
                <Row label="Method">{event.method}</Row>
                <Row label="Endpoint">{event.endpoint}</Row>
                <Row label="Request ID">
                    <span className="text-muted-foreground">{event.id}</span>
                </Row>
                <Row label="Status">
                    <StatusBadge status={event.status} />
                </Row>
                <Row label="Duration">
                    {event.durationMs !== undefined ? (
                        <span className={event.durationMs >= 1000 ? 'text-warning' : ''}>
                            {event.durationMs.toFixed(1)} ms
                        </span>
                    ) : (
                        <span className="text-muted-foreground">—</span>
                    )}
                </Row>
                <Row label="Attempt">{event.attempt + 1}</Row>
                {event.errorCode && <Row label="Error code">{event.errorCode}</Row>}
                {event.errorMessage && (
                    <Row label="Error message">
                        <span className="text-destructive">{event.errorMessage}</span>
                    </Row>
                )}
            </div>
        </div>
    );
}
