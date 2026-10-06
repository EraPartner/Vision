import type { ReactNode } from "react";
import {
    SegmentedControl,
    SegmentedControlItem,
    type SegmentedControlProps,
} from "@/components/ui/segmented-control";

interface SegmentedButtonsProps<T> {
    options: T[];
    getKey: (option: T) => string | number;
    getLabel: (option: T) => ReactNode;
    isSelected: (option: T) => boolean;
    onSelect: (option: T) => void;
    /** Extra classes on each segment, for example `tabular-nums`. */
    buttonClassName?: string;
    className?: string;
    size?: SegmentedControlProps["size"];
    "aria-label"?: string;
    "aria-labelledby"?: string;
}

/**
 * Option row over a list of options, rendered as the segmented control
 * (ADR-179). Keeps the predicate-based API the research pages use; the
 * selected option is the one `isSelected` reports.
 */
export function SegmentedButtons<T>({
    options,
    getKey,
    getLabel,
    isSelected,
    onSelect,
    buttonClassName,
    className,
    size = "sm",
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
}: SegmentedButtonsProps<T>) {
    const selected = options.find(isSelected);
    const value = selected === undefined ? undefined : String(getKey(selected));
    return (
        <SegmentedControl
            className={className}
            size={size}
            value={value ?? ""}
            onValueChange={(next) => {
                const option = options.find((o) => String(getKey(o)) === next);
                if (option !== undefined) onSelect(option);
            }}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
        >
            {options.map((option) => (
                <SegmentedControlItem
                    key={getKey(option)}
                    value={String(getKey(option))}
                    className={buttonClassName}
                >
                    {getLabel(option)}
                </SegmentedControlItem>
            ))}
        </SegmentedControl>
    );
}
