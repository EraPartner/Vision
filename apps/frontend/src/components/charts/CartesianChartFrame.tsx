import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { extent, max, min } from "d3-array";
import {
    type FocusEventHandler,
    type KeyboardEventHandler,
    type ReactNode,
    useCallback,
    useMemo,
    useRef,
} from "react";

export interface CartesianChartMargin {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
}

export type CartesianXScale =
    | ReturnType<typeof scaleTime<number>>
    | ReturnType<typeof scaleLinear<number>>;

interface ResponsiveCartesianFrameProps {
    readonly height: number;
    readonly width?: number;
    readonly children: (size: { width: number; height: number }) => ReactNode;
}

/** Resolve an explicit chart width or measure the available parent bounds. */
export function ResponsiveCartesianFrame({
    height,
    width,
    children,
}: ResponsiveCartesianFrameProps) {
    if (width !== undefined) return children({ width, height });

    return (
        <div style={{ width: "100%", height }}>
            <ParentSize>
                {({ width: measuredWidth, height: measuredHeight }) =>
                    measuredWidth > 0 && measuredHeight > 0
                        ? children({
                              width: measuredWidth,
                              height: measuredHeight,
                          })
                        : null
                }
            </ParentSize>
        </div>
    );
}

interface UseCartesianFrameOptions<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly xIsDate: boolean;
    readonly width: number;
    readonly height: number;
    readonly margin: CartesianChartMargin;
}

/** Shared Cartesian bounds and horizontal scale used by the Visx chart primitives. */
// This module deliberately co-locates the frame hook with its two frame components.
// eslint-disable-next-line react-refresh/only-export-components
export function useCartesianFrame<Datum>({
    data,
    xAccessor,
    xIsDate,
    width,
    height,
    margin,
}: UseCartesianFrameOptions<Datum>) {
    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    // Keep inline accessors from invalidating scales and memoized series layers.
    const xAccessorRef = useRef(xAccessor);
    xAccessorRef.current = xAccessor;
    const stableXAccessor = useCallback(
        (datum: Datum) => xAccessorRef.current(datum),
        [],
    );

    const xScale = useMemo<CartesianXScale>(() => {
        const values = data.map(stableXAccessor);
        if (xIsDate) {
            const [lo, hi] = extent(values as Date[]);
            return scaleTime({
                range: [0, innerWidth],
                domain: [lo ?? new Date(), hi ?? new Date()],
            });
        }

        const numbers = values as number[];
        return scaleLinear({
            range: [0, innerWidth],
            domain: [min(numbers) ?? 0, max(numbers) ?? 0],
        });
    }, [data, innerWidth, stableXAccessor, xIsDate]);

    return { innerWidth, innerHeight, stableXAccessor, xScale };
}

interface CartesianChartFrameProps {
    readonly width: number;
    readonly height: number;
    readonly ariaLabel: string;
    readonly pointCount: number;
    readonly onKeyDown: KeyboardEventHandler<SVGSVGElement>;
    readonly onBlur: FocusEventHandler<SVGSVGElement>;
    readonly children: ReactNode;
}

/** The common accessible SVG shell for Cartesian chart primitives. */
export function CartesianChartFrame({
    width,
    height,
    ariaLabel,
    pointCount,
    onKeyDown,
    onBlur,
    children,
}: CartesianChartFrameProps) {
    return (
        <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel}
            tabIndex={pointCount > 0 ? 0 : undefined}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
        >
            {children}
        </svg>
    );
}
