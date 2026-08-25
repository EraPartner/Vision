import { cn } from '@/lib/utils';

type ShimmerLayerProps = React.HTMLAttributes<HTMLDivElement>;

/** Paints the shimmer once, then moves the composited layer with transform. */
function ShimmerLayer({ className, ...props }: ShimmerLayerProps) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                'pointer-events-none absolute inset-y-0 left-0 w-full animate-shimmer',
                className,
            )}
            {...props}
        />
    );
}

export { ShimmerLayer };
