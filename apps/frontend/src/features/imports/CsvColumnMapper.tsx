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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

// NONE sentinel — means "not mapped / leave empty"
const NONE = "__none__";

interface ColumnSelectProps {
  id: string;
  label: string;
  value: string;
  headers: string[];
  required?: boolean;
  onChange: (val: string) => void;
  noMappingLabel: string;
}

function ColumnSelect({
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
      <Select
        value={value || NONE}
        onValueChange={(v) => onChange(v === NONE ? "" : v)}
      >
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

export function CsvColumnMapper({ file, separator, config, onChange }: Props) {
  const { t } = useLanguage();
  const { preview } = useCsvPreview(file, separator);

  const hasHeaders = preview && preview.headers.length > 0;

  const set = (key: keyof CsvColumnConfig) => (val: string) =>
    onChange({ ...config, [key]: val });

  const noMappingLabel = t("importPage.noMapping");

  return (
    <div className="space-y-4">
      {/* Column selects or text inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {hasHeaders ? (
          <>
            <ColumnSelect
              id="date-column"
              label={t("importPage.dateCol")}
              value={config.dateColumn}
              headers={preview.headers}
              required
              onChange={set("dateColumn")}
              noMappingLabel={noMappingLabel}
            />
            <ColumnSelect
              id="recipient-column"
              label={t("importPage.recipientCol")}
              value={config.recipientColumn}
              headers={preview.headers}
              required
              onChange={set("recipientColumn")}
              noMappingLabel={noMappingLabel}
            />
            <ColumnSelect
              id="amount-column"
              label={t("importPage.amountCol")}
              value={config.amountColumn}
              headers={preview.headers}
              required
              onChange={set("amountColumn")}
              noMappingLabel={noMappingLabel}
            />
            <ColumnSelect
              id="memo-column"
              label={t("importPage.memoCol")}
              value={config.memoColumn}
              headers={preview.headers}
              onChange={set("memoColumn")}
              noMappingLabel={noMappingLabel}
            />
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="date-column">{t("importPage.dateCol")}</Label>
              <Input
                id="date-column"
                placeholder={t("importPage.dateColPlaceholder")}
                value={config.dateColumn}
                onChange={(e) => set("dateColumn")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipient-column">{t("importPage.recipientCol")}</Label>
              <Input
                id="recipient-column"
                placeholder={t("importPage.recipientColPlaceholder")}
                value={config.recipientColumn}
                onChange={(e) => set("recipientColumn")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount-column">{t("importPage.amountCol")}</Label>
              <Input
                id="amount-column"
                placeholder={t("importPage.amountColPlaceholder")}
                value={config.amountColumn}
                onChange={(e) => set("amountColumn")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="memo-column">{t("importPage.memoCol")}</Label>
              <Input
                id="memo-column"
                placeholder={t("importPage.memoColPlaceholder")}
                value={config.memoColumn}
                onChange={(e) => set("memoColumn")(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      {/* Loading / error states */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("importPage.csvParsing")}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          {t("importPage.csvParseError")}
        </div>
      )}

      {/* Preview table */}
      {hasHeaders && preview.rows.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t("importPage.csvPreviewTitle")}
          </p>
          <div className="overflow-x-auto rounded-md border text-xs">
            <Table>
              <TableHeader>
                <TableRow>
                  {preview.headers.map((h) => (
                    <TableHead
                      key={h}
                      className={
                        [
                          config.dateColumn,
                          config.recipientColumn,
                          config.amountColumn,
                          config.memoColumn,
                        ].includes(h)
                          ? "bg-primary/5 text-primary font-semibold"
                          : "text-muted-foreground"
                      }
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((row, ri) => (
                  <TableRow key={ri}>
                    {row.map((cell, ci) => {
                      const header = preview.headers[ci];
                      const isMapped = [
                        config.dateColumn,
                        config.recipientColumn,
                        config.amountColumn,
                        config.memoColumn,
                      ].includes(header);
                      return (
                        <TableCell
                          key={ci}
                          className={isMapped ? "text-foreground" : "text-muted-foreground"}
                        >
                          <span className="line-clamp-1 max-w-[120px] block">{cell || "—"}</span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
