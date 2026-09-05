/**
 * Shared CSV format dropdowns (separator / encoding / date-format) used by the
 * transaction, portfolio, recipients and categories import surfaces. Previously
 * each surface inlined these — and drifted (separator labels were translated in
 * two places and hard-coded in two others). Centralising them keeps the option
 * lists and i18n consistent.
 */

import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { CANDIDATE_SEPARATORS } from "./csvSeparator";

interface FormatSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

const SEPARATOR_LABEL_KEYS: Record<string, string> = {
  ",": "importPage.sep.comma",
  ";": "importPage.sep.semicolon",
  "\t": "importPage.sep.tab",
  "|": "importPage.sep.pipe",
};

export function SeparatorSelect({ id, value, onChange }: FormatSelectProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("importPage.separator")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CANDIDATE_SEPARATORS.map((sep) => (
            <SelectItem key={sep} value={sep}>
              {t(SEPARATOR_LABEL_KEYS[sep])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const ENCODING_OPTIONS: Array<[string, string]> = [
  ["utf-8", "UTF-8"],
  ["latin-1", "Latin-1"],
  ["iso-8859-1", "ISO-8859-1"],
  ["windows-1252", "Windows-1252"],
];

export function EncodingSelect({ id, value, onChange }: FormatSelectProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("importPage.encoding")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENCODING_OPTIONS.map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const DATE_FORMAT_OPTIONS: Array<[string, string]> = [
  ["%Y-%m-%d", "YYYY-MM-DD (2024-12-31)"],
  ["%d/%m/%Y", "DD/MM/YYYY (31/12/2024)"],
  ["%m/%d/%Y", "MM/DD/YYYY (12/31/2024)"],
  ["%d-%m-%Y", "DD-MM-YYYY (31-12-2024)"],
  ["%Y-%m-%d %H:%M:%S", "YYYY-MM-DD HH:MM:SS"],
];

export function DateFormatSelect({ id, value, onChange }: FormatSelectProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("importPage.dateFormat")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_FORMAT_OPTIONS.map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
