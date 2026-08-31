import type { ReactNode } from "react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { BelgianRegion } from "@/contexts/BelgianTaxProfileContext";

interface BelgianRegionSelectProps {
    id: string;
    value: BelgianRegion;
    onValueChange: (value: BelgianRegion) => void;
    className?: string;
}

export function BelgianRegionSelect({
    id,
    value,
    onValueChange,
    className,
}: BelgianRegionSelectProps) {
    return (
        <Select
            value={value}
            onValueChange={(next) => onValueChange(next as BelgianRegion)}
        >
            <SelectTrigger id={id} className={className}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="flanders">Flanders</SelectItem>
                <SelectItem value="wallonia">Wallonia</SelectItem>
                <SelectItem value="brussels">Brussels</SelectItem>
            </SelectContent>
        </Select>
    );
}

interface BoundedCountSelectProps {
    id: string;
    value: number;
    max: number;
    onValueChange: (value: number) => void;
    renderOption: (value: number) => ReactNode;
}

export function BoundedCountSelect({
    id,
    value,
    max,
    onValueChange,
    renderOption,
}: BoundedCountSelectProps) {
    return (
        <Select
            value={String(value)}
            onValueChange={(next) => onValueChange(Number.parseInt(next, 10))}
        >
            <SelectTrigger id={id}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {Array.from({ length: max + 1 }, (_, option) => (
                    <SelectItem key={option} value={String(option)}>
                        {renderOption(option)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
