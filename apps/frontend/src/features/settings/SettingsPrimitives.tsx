import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

/**
 * Shared layout primitives for the Settings dialog. One visual language for
 * every setting: a section (title + optional description) holds one or more
 * cards; each card is a bordered, row-divided group of SettingRows.
 *
 * These replace the previous per-tab mix of bare rows, full-width separators,
 * and ad-hoc bordered cards.
 */

interface SettingsSectionProps {
    title: ReactNode;
    description?: ReactNode;
    /** Optional trailing element rendered on the title row (e.g. a status pill). */
    aside?: ReactNode;
    children: ReactNode;
}

export function SettingsSection({
    title,
    description,
    aside,
    children,
}: SettingsSectionProps) {
    return (
        <section className="space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">
                        {title}
                    </h2>
                    {description && (
                        <p className="text-sm text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {aside && <div className="shrink-0">{aside}</div>}
            </div>
            <div className="space-y-5">{children}</div>
        </section>
    );
}

interface SettingsGroupProps {
    /** Optional small label above the card grouping a cluster of rows. */
    label?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * A bordered card that groups related SettingRows, dividing them with hairlines
 * instead of full-width separators. Pass `label` and `description` for group
 * context above the card without inventing another section-heading anatomy.
 */
export function SettingsGroup({
    label,
    description,
    children,
    className,
}: SettingsGroupProps) {
    return (
        <div className="space-y-2">
            {(label || description) && (
                <div className="space-y-0.5 px-1">
                    {label && <div className="eyebrow">{label}</div>}
                    {description && (
                        <p className="text-xs text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
            )}
            <div
                className={cn(
                    "overflow-hidden rounded-xl border border-border bg-card/40 divide-y divide-border/60",
                    className,
                )}
            >
                {children}
            </div>
        </div>
    );
}

interface SettingRowProps {
    title: ReactNode;
    description?: ReactNode;
    /** Associates the title <Label> with a control's id for click-to-focus. */
    htmlFor?: string;
    /** Gives the title <Label> an id so a control can reference it via aria-labelledby. */
    labelId?: string;
    /**
     * 'row' (default): title/description left, control right — for switches and
     * compact selects. 'stack': control sits full-width below the title — for
     * search inputs, lists, and anything that needs the full width.
     */
    layout?: "row" | "stack";
    /** Tone the row for destructive actions (danger zone). */
    destructive?: boolean;
    children: ReactNode;
    className?: string;
}

export interface SelectRowConfig {
    title: string;
    description?: string;
    value: string;
    onValueChange: (v: string) => void;
    options: { value: string; label: ReactNode }[];
    /** aria-label for the select trigger when the row label alone is ambiguous. */
    triggerAriaLabel?: string;
    /** Optional extra content rendered below the select (e.g. hint notes). */
    children?: ReactNode;
}

/**
 * One SettingRow→Select block. The select rows across the settings sections
 * were identical apart from their title/value/options/change handler, now
 * expressed as config.
 */
export function SelectSettingRow({
    title,
    description,
    value,
    onValueChange,
    options,
    triggerAriaLabel,
    children,
}: SelectRowConfig) {
    // Give the Radix SelectTrigger (role=combobox) an accessible name by pointing
    // it at the row's title <Label> — comboboxes otherwise announce only their value.
    const labelId = useId();
    return (
        <SettingRow
            title={title}
            description={description}
            labelId={labelId}
            layout="stack"
        >
            <Select value={value} onValueChange={onValueChange}>
                <SelectTrigger
                    aria-labelledby={labelId}
                    aria-label={triggerAriaLabel}
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {children}
        </SettingRow>
    );
}

export function SettingRow({
    title,
    description,
    htmlFor,
    labelId,
    layout = "row",
    destructive,
    children,
    className,
}: SettingRowProps) {
    const titleClassName = cn(
        "text-sm font-medium",
        htmlFor && "cursor-pointer",
        destructive && "text-destructive",
    );
    const heading = (
        <div className="space-y-0.5">
            {htmlFor || labelId ? (
                <Label
                    id={labelId}
                    htmlFor={htmlFor}
                    className={titleClassName}
                >
                    {title}
                </Label>
            ) : (
                <p className={titleClassName}>{title}</p>
            )}
            {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
            )}
        </div>
    );

    if (layout === "stack") {
        return (
            <div className={cn("space-y-3 px-4 py-3.5", className)}>
                {heading}
                <div>{children}</div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                "flex items-center justify-between gap-4 px-4 py-3.5",
                className,
            )}
        >
            {heading}
            <div className="shrink-0">{children}</div>
        </div>
    );
}
