import {cn} from "@/lib/utils";
import { ShimmerLayer } from '@/components/ui/shimmer-layer';

/**
 * A single shimmer bone.
 *
 * `aria-hidden` by default: the shape conveys nothing a screen reader can use,
 * and most surfaces stack several of them, so announcing each one is pure
 * noise. The enclosing element carries the `useLoadingSurfaceProps()` props
 * and announces once for the whole surface.
 */
function Skeleton({className, ...props}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "relative overflow-hidden rounded-md bg-foreground/[0.06]",
                className,
            )}
            {...props}
        >
            <ShimmerLayer className="bg-[linear-gradient(90deg,transparent_0%,hsl(var(--foreground)/0.08)_50%,transparent_100%)]" />
        </div>
    );
}

export {Skeleton};
