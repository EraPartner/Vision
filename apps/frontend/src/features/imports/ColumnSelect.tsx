/**
 * ColumnSelect — a single "map this field to a CSV column" dropdown, shared by
 * the transaction and portfolio column mappers. Renders the shared "none"
 * sentinel option ("leave empty") because Radix Select cannot hold an
 * empty-string value.
 */

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { SELECT_NONE, fromSelectValue, toSelectValue } from "@/lib/selectValue";

interface ColumnSelectProps {
    id: string;
    label: string;
    value: string;
    headers: string[];
    required?: boolean;
    onChange: (value: string) => void;
    noMappingLabel: string;
}

interface MappedColumnFieldProps extends ColumnSelectProps {
    /** Whether the CSV preview yielded header names to pick from. */
    hasHeaders: boolean;
    /** Placeholder for the no-headers text input. */
    placeholder?: string;
}

/**
 * One column-mapping field: a ColumnSelect dropdown when the file's headers
 * are known, else a plain text input for typing the column name. Shared by
 * the transaction and portfolio column mappers.
 */
export function MappedColumnField({
    hasHeaders,
    placeholder,
    ...props
}: MappedColumnFieldProps) {
    if (hasHeaders) return <ColumnSelect {...props} />;
    return (
        <div className="space-y-2">
            <Label htmlFor={props.id}>
                {props.label}
                {props.required && <span aria-hidden="true"> *</span>}
            </Label>
            <Input
                id={props.id}
                placeholder={placeholder}
                value={props.value}
                aria-required={props.required || undefined}
                onChange={(e) => props.onChange(e.target.value)}
            />
        </div>
    );
}

export function ColumnSelect({
    id,
    label,
    value,
    headers,
    required,
    onChange,
    noMappingLabel,
}: ColumnSelectProps) {
    return (
        <div className="space-y-2">
            <Label htmlFor={id}>
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </Label>
            <Select
                value={toSelectValue(value)}
                onValueChange={(v) => onChange(fromSelectValue(v))}
            >
                <SelectTrigger id={id} aria-required={required || undefined}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={SELECT_NONE}>
                        <span className="text-muted-foreground">
                            {noMappingLabel}
                        </span>
                    </SelectItem>
                    {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                            {h}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
