import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface SegmentedButtonsProps<T> {
    options: T[];
    getKey: (option: T) => string | number;
    getLabel: (option: T) => ReactNode;
    isSelected: (option: T) => boolean;
    onSelect: (option: T) => void;
    /** Per-button sizing classes; sites differ on height/padding. */
    buttonClassName?: string;
    className?: string;
}

/**
 * The research pages' segmented option row: a flex strip of small buttons
 * where the selected one is "default" and the rest are "ghost".
 */
export function SegmentedButtons<T>({
    options,
    getKey,
    getLabel,
    isSelected,
    onSelect,
    buttonClassName = "h-8 px-2.5 text-xs",
    className = "flex gap-1",
}: SegmentedButtonsProps<T>) {
    return (
        <div className={className}>
            {options.map((option) => (
                <Button
                    key={getKey(option)}
                    size="sm"
                    variant={isSelected(option) ? "default" : "ghost"}
                    className={buttonClassName}
                    onClick={() => onSelect(option)}
                >
                    {getLabel(option)}
                </Button>
            ))}
        </div>
    );
}
