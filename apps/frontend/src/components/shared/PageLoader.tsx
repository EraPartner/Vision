import { ShimmerLayer } from '@/components/ui/shimmer-layer';

/** Route-chunk loading indicator pinned to the top edge. */
export function PageLoader() {
    return (
        <div
            aria-busy="true"
            className="fixed inset-x-0 top-0 z-50 h-[2px] overflow-hidden motion-reduce:bg-primary/60"
        >
            <ShimmerLayer className="bg-[linear-gradient(90deg,transparent_0%,hsl(var(--primary))_35%,hsl(var(--accent))_65%,transparent_100%)] motion-reduce:hidden" />
        </div>
    );
}
