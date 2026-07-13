/**
 * CsvColumnMapper — visual column-mapping UI for custom CSV imports.
 *
 * When a CSV file is provided it parses the header row client-side and
 * renders dropdown selects so users can pick which column maps to which
 * transaction field.  Falls back to plain text inputs when no file is
 * loaded yet. The file's columns + sample rows are shown by the shared
 * FileHeadersPanel (rendered alongside this component), not here.
 */

import { useLanguage } from "@/contexts/LanguageContext";
import { useCsvPreview } from "@/hooks/useCsvPreview";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ColumnSelect } from "./ColumnSelect";

export interface CsvColumnConfig {
  dateColumn: string;
  recipientColumn: string;
  amountColumn: string;
  memoColumn: string;
}

interface Props {
  file: File | null;
  separator: string;
  config: CsvColumnConfig;
  onChange: (next: CsvColumnConfig) => void;
}

// [state key, input id, label key, placeholder key, required] — one row per
// mapped column, driving both the select (with headers) and text-input (no
// headers) branches, mirroring PortfolioCsvColumnMapper's config-array pattern.
const COLUMN_FIELDS: [keyof CsvColumnConfig, string, string, string, boolean][] = [
  ["dateColumn", "date-column", "importPage.dateCol", "importPage.dateColPlaceholder", true],
  ["recipientColumn", "recipient-column", "importPage.recipientCol", "importPage.recipientColPlaceholder", true],
  ["amountColumn", "amount-column", "importPage.amountCol", "importPage.amountColPlaceholder", true],
  ["memoColumn", "memo-column", "importPage.memoCol", "importPage.memoColPlaceholder", false],
];

export function CsvColumnMapper({ file, separator, config, onChange }: Props) {
  const { t } = useLanguage();
  const { preview } = useCsvPreview(file, separator);

  const headers = preview?.headers ?? [];
  const hasHeaders = headers.length > 0;

  const set = (key: keyof CsvColumnConfig) => (val: string) =>
    onChange({ ...config, [key]: val });

  const noMappingLabel = t("importPage.noMapping");

  return (
    <div className="space-y-4">
      {/* Column selects or text inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {COLUMN_FIELDS.map(([key, id, labelKey, placeholderKey, required]) => (
          hasHeaders ? (
            <ColumnSelect
              key={key}
              id={id}
              label={t(labelKey)}
              value={config[key]}
              headers={headers}
              required={required}
              onChange={set(key)}
              noMappingLabel={noMappingLabel}
            />
          ) : (
            <div key={key} className="space-y-2">
              <Label htmlFor={id}>{t(labelKey)}</Label>
              <Input
                id={id}
                placeholder={t(placeholderKey)}
                value={config[key]}
                onChange={(e) => set(key)(e.target.value)}
              />
            </div>
          )
        ))}
      </div>
    </div>
  );
}
