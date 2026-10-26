import { cn } from "@/lib/utils";
import { ShimmerLayer } from '@/components/ui/shimmer-layer';

interface ChartSkeletonProps {
    height?: number | undefined;
    className?: string | undefined;
}

/**
 * Chart loading state shaped like a chart: a faint ghost waveform with a
 * shimmer sweep, instead of a blank rectangle. Pure CSS/SVG — no data.
 */
export function ChartSkeleton({ height = 280, className }: ChartSkeletonProps) {
    return (
        <div
            aria-hidden="true"
            className={cn("relative w-full rounded-card corner-continuous", className)}
            style={{ height }}
        >
            {/* Two clips, not one on the outer box: the painted ghost keeps
                the squircle, while the moving (composited) shimmer gets a
                plain rounded clip. A squircle clip around a composited layer
                costs a mask layer and an extra surface on every frame. */}
            <div className="absolute inset-0 overflow-hidden rounded-[inherit] corner-continuous">
                <svg
                    className="h-full w-full text-muted-foreground/25"
                    viewBox="0 0 400 160"
                    preserveAspectRatio="none"
                >
                    {[40, 80, 120].map((y) => (
                        <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 4" />
                    ))}
                    <path
                        d="M0,120 C30,100 50,135 80,110 C110,85 130,125 160,95 C190,65 210,105 240,80 C270,55 290,95 320,70 C350,45 370,75 400,55"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        strokeLinecap="round"
                    />
                    <path
                        d="M0,120 C30,100 50,135 80,110 C110,85 130,125 160,95 C190,65 210,105 240,80 C270,55 290,95 320,70 C350,45 370,75 400,55 L400,160 L0,160 Z"
                        fill="currentColor"
                        fillOpacity={0.12}
                    />
                </svg>
            </div>
            <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
                <ShimmerLayer className="bg-[linear-gradient(90deg,transparent_0%,hsl(var(--foreground)/0.05)_50%,transparent_100%)]" />
            </div>
        </div>
    );
}
