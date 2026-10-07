import { forwardRef, useId } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface ListFilterToggleProps {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label: string;
}

export const ListFilterToggle = forwardRef<
    HTMLButtonElement,
    ListFilterToggleProps
>(({ checked, onCheckedChange, label }, ref) => {
    const id = useId();
    return (
        <div className="flex min-h-9 items-center gap-2 rounded-control border border-border/60 px-3">
            <Switch
                ref={ref}
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
            />
            <Label
                htmlFor={id}
                className="cursor-pointer whitespace-nowrap"
            >
                {label}
            </Label>
        </div>
    );
});
ListFilterToggle.displayName = "ListFilterToggle";
