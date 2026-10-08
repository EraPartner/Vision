import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Row surfaces for the tax-profile steps. A choice between a few options and
 * a list of boolean settings both read as one inset group (the `List`
 * material from ADR-179) whose rows keep a full description line; the shared
 * `ListRow` truncates its subtitle, which these explanations cannot afford.
 */
const groupSurfaceClass =
    "overflow-hidden rounded-card corner-continuous border border-border/60 bg-card/70";

interface StepIntroProps {
    title: ReactNode;
    description?: ReactNode;
}

/** Heading and one-line explanation at the top of a step or a step section. */
export function StepIntro({ title, description }: StepIntroProps) {
    return (
        <div className="space-y-1">
            <h3 className="type-headline text-foreground">{title}</h3>
            {description && (
                <p className="type-footnote text-label-secondary">
                    {description}
                </p>
            )}
        </div>
    );
}

/** Secondary explanation under a field. */
export function FieldHint({
    className,
    ...props
}: ComponentPropsWithoutRef<"p">) {
    return (
        <p
            className={cn("type-footnote text-label-secondary", className)}
            {...props}
        />
    );
}

type ChoiceGroupProps = ComponentPropsWithoutRef<typeof RadioGroup>;

/** Radio group drawn as an inset list; pair with `ChoiceRow`. */
export function ChoiceGroup({ className, ...props }: ChoiceGroupProps) {
    return (
        <RadioGroup
            className={cn(
                groupSurfaceClass,
                "gap-0 divide-y divide-border/50",
                className,
            )}
            {...props}
        />
    );
}

interface ChoiceRowProps {
    id: string;
    value: string;
    checked: boolean;
    label: ReactNode;
    description?: ReactNode;
}

export function ChoiceRow({
    id,
    value,
    checked,
    label,
    description,
}: ChoiceRowProps) {
    return (
        <label
            htmlFor={id}
            className={cn(
                "flex cursor-default items-start gap-3 px-4 py-3 transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04]",
                checked && "bg-primary/[0.06]",
            )}
        >
            <RadioGroupItem id={id} value={value} className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="type-body font-medium text-foreground">
                    {label}
                </span>
                {description && (
                    <span className="type-footnote text-label-secondary">
                        {description}
                    </span>
                )}
            </span>
        </label>
    );
}

/** Inset group of `ToggleRow`s. */
export function ToggleGroup({
    className,
    ...props
}: ComponentPropsWithoutRef<"div">) {
    return (
        <div
            className={cn(
                groupSurfaceClass,
                "divide-y divide-border/50",
                className,
            )}
            {...props}
        />
    );
}

interface ToggleRowProps {
    id: string;
    label: ReactNode;
    description?: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}

export function ToggleRow({
    id,
    label,
    description,
    checked,
    onCheckedChange,
}: ToggleRowProps) {
    return (
        <div className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
                <Label htmlFor={id}>{label}</Label>
                {description && <FieldHint>{description}</FieldHint>}
            </div>
            <Switch
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
            />
        </div>
    );
}
