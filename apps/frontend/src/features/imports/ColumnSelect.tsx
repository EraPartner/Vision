/**
 * ColumnSelect — a single "map this field to a CSV column" dropdown, shared by
 * the transaction and portfolio column mappers. Renders a NONE sentinel option
 * ("leave empty") because Radix Select cannot hold an empty-string value.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export const NONE = "__none__";

interface ColumnSelectProps {
  id: string;
  label: string;
  value: string;
  headers: string[];
  required?: boolean;
  onChange: (value: string) => void;
  noMappingLabel: string;
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
        {required && " *"}
      </Label>
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-muted-foreground">{noMappingLabel}</span>
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
