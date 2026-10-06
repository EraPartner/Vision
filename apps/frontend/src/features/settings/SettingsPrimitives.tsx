import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { List } from "@/components/ui/list";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

/**
 * Shared layout primitives for the Settings window (ADR-183). One visual
 * language for every setting: a section is the content of one sidebar entry
 * and holds one or more groups; each group is a Card whose flush content is an
 * inset list of SettingRows (label and optional footnote on the left, an h-9
 * control on the right).
 *
 * The window's title bar already names the section, so SettingsSection renders
 * no heading of its own; `title` labels the landmark for assistive technology.
 */

interface SettingsSectionProps {
    title: string;
    children: ReactNode;
}

export function SettingsSection({ title, children }: SettingsSectionProps) {
    return (
        <section aria-label={title} className="space-y-6">
            {children}
        </section>
    );
}

interface SettingsGroupProps {
    /** Group title above the rows, set as a label-variant card title. */
    label?: ReactNode;
    description?: ReactNode;
    /** Optional trailing element on the title row (e.g. a count badge). */
    aside?: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * A Card that groups related SettingRows on one surface, dividing them with
 * hairlines. Pass `label` and `description` for group context without
 * inventing another heading anatomy.
 */
export function SettingsGroup({
    label,
    description,
    aside,
    children,
    className,
}: SettingsGroupProps) {
    return (
        <Card className={cn("@container/settings", className)}>
            {(label || description) && (
                <CardHeader className="space-y-0.5 px-4 pb-2 pt-4">
                    <div className="flex items-center justify-between gap-3">
                        {label ? (
                            <CardTitle variant="label" level={3}>
                                {label}
                            </CardTitle>
                        ) : (
                            <span />
                        )}
                        {aside && <div className="shrink-0">{aside}</div>}
                    </div>
                    {description && (
                        <CardDescription className="type-footnote">
                            {description}
                        </CardDescription>
                    )}
                </CardHeader>
            )}
            <CardContent variant="flush">
                <List className="rounded-none border-0 bg-transparent">
                    {children}
                </List>
            </CardContent>
        </Card>
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
     * 'row' (default): title/description left, control right — for switches,
     * buttons and compact selects. 'stack': control sits full-width below the
     * title — for search inputs, lists, and anything that needs the full width.
     * 'responsive': selects sit beside the label when the group has room, and
     * below it when the content pane is narrow.
     */
    layout?: "row" | "stack" | "responsive";
    /** Tone the row for destructive actions. */
    destructive?: boolean;
    /** Keep the title for assistive technology only (e.g. a search field whose placeholder says it). */
    titleHidden?: boolean;
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
 * are identical apart from their title/value/options/change handler, so they
 * are expressed as config.
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
            // Supplemental content can include schedules or previews that
            // need the full row width. Only simple choices use compact rows.
            layout={children ? "stack" : "responsive"}
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
    titleHidden,
    children,
    className,
}: SettingRowProps) {
    const titleClassName = cn(
        "type-body font-normal leading-tight",
        destructive ? "text-destructive" : "text-foreground",
        htmlFor && "cursor-pointer",
    );
    const heading = (
        <div className={cn("min-w-0 space-y-0.5", titleHidden && "sr-only")}>
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
                <p className="type-footnote text-label-secondary">
                    {description}
                </p>
            )}
        </div>
    );

    if (layout === "stack") {
        return (
            <li className={cn("space-y-3 px-4 py-3", className)}>
                {heading}
                <div>{children}</div>
            </li>
        );
    }

    if (layout === "responsive") {
        return (
            <li
                className={cn(
                    "grid min-h-11 items-center gap-3 px-4 py-2.5 @min-[28rem]/settings:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] @min-[28rem]/settings:gap-6",
                    className,
                )}
            >
                {heading}
                <div className="min-w-0">{children}</div>
            </li>
        );
    }

    return (
        <li
            className={cn(
                "flex min-h-11 items-center justify-between gap-4 px-4 py-2.5",
                className,
            )}
        >
            {heading}
            <div className="flex shrink-0 items-center">{children}</div>
        </li>
    );
}
