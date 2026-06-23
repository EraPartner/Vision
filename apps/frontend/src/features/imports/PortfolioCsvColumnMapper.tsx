/**
 * PortfolioCsvColumnMapper — column-mapping UI for portfolio (brokerage) CSV
 * imports. Like CsvColumnMapper but with the portfolio field set, a default
 * asset-class / default-type, and a small type-mapping editor seeded from the
 * raw values found in the chosen type column. The file's columns are shown by
 * the shared FileHeadersPanel rendered by the parent page (same ownership model
 * as the transaction import card), not here.
 */

import { useMemo } from "react";
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
import { ColumnSelect, NONE } from "./ColumnSelect";
import { PORTFOLIO_COLUMN_FIELDS } from "./portfolioColumnFields";
import { ASSET_CLASSES } from "@/utils/assetClass";
import type { PortfolioCustomConfig, PortfolioTxnTypeValue, AssetClassValue } from "@/lib/api/portfolioImports";

const ASSET_CLASS_OPTIONS: readonly AssetClassValue[] = ASSET_CLASSES;

// The types with existing UI labels (portfolio.txnType.*). Corporate actions
// (split/merger/...) are still importable when the CSV value is canonical, but
// are not offered in the dropdowns.
const TXN_TYPE_OPTIONS: PortfolioTxnTypeValue[] = [
  "buy", "sell", "dividend", "fee", "tax", "interest", "gift", "rent_income", "appreciation",
];

interface Props {
  file: File | null;
  separator: string;
  config: PortfolioCustomConfig;
  onChange: (next: PortfolioCustomConfig) => void;
}

export function PortfolioCsvColumnMapper({ file, separator, config, onChange }: Props) {
  const { t } = useLanguage();
  const { preview } = useCsvPreview(file, separator);
  const headers = preview?.headers ?? [];
  const hasHeaders = headers.length > 0;
  const noMappingLabel = t("importPage.noMapping");

  const set = <K extends keyof PortfolioCustomConfig>(key: K) => (value: PortfolioCustomConfig[K]) =>
    onChange({ ...config, [key]: value });

  // Distinct raw values in the chosen type column, from the preview rows, to
  // seed the type-mapping editor.
  const distinctTypeValues = useMemo(() => {
    if (!config.typeColumn || !preview) return [];
    const colIdx = preview.headers.indexOf(config.typeColumn);
    if (colIdx < 0) return [];
    const seen = new Set<string>();
    for (const row of preview.rows) {
      const v = (row[colIdx] ?? "").trim();
      if (v) seen.add(v);
    }
    return [...seen];
  }, [config.typeColumn, preview]);

  const setMapping = (raw: string, canonical: string) => {
    const next = { ...config.typeMapping };
    if (canonical === NONE) delete next[raw];
    else next[raw] = canonical;
    onChange({ ...config, typeMapping: next });
  };

  return (
    <div className="space-y-4">
      {/* Defaults */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="pf-asset-class">{t("portfolioImport.defaultAssetClass")} *</Label>
          <Select value={config.defaultAssetClass} onValueChange={(v) => set("defaultAssetClass")(v as AssetClassValue)}>
            <SelectTrigger id="pf-asset-class"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ASSET_CLASS_OPTIONS.map((ac) => (
                <SelectItem key={ac} value={ac}>{t(`portfolio.assetClass.${ac}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pf-default-type">{t("portfolioImport.defaultType")}</Label>
          <Select value={config.defaultType} onValueChange={(v) => set("defaultType")(v as PortfolioTxnTypeValue)}>
            <SelectTrigger id="pf-default-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TXN_TYPE_OPTIONS.map((tp) => (
                <SelectItem key={tp} value={tp}>{t(`portfolio.txnType.${tp}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Column mapping */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {PORTFOLIO_COLUMN_FIELDS.map(([key, labelKey, required]) => (
          hasHeaders ? (
            <ColumnSelect
              key={key}
              id={`pf-${key}`}
              label={t(labelKey)}
              value={String(config[key] ?? "")}
              headers={headers}
              required={required}
              onChange={(v) => set(key)(v as never)}
              noMappingLabel={noMappingLabel}
            />
          ) : (
            <div key={key} className="space-y-2">
              <Label htmlFor={`pf-${key}`}>{t(labelKey)}{required && " *"}</Label>
              <Input
                id={`pf-${key}`}
                value={String(config[key] ?? "")}
                onChange={(e) => set(key)(e.target.value as never)}
              />
            </div>
          )
        ))}
      </div>

      {/* Type-value mapping */}
      {config.typeColumn && distinctTypeValues.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("portfolioImport.typeMappingTitle")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {distinctTypeValues.map((raw) => (
              <div key={raw} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{raw}</span>
                <Select
                  value={config.typeMapping?.[raw] ?? NONE}
                  onValueChange={(v) => setMapping(raw, v)}
                >
                  <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">{t("portfolioImport.typeMappingAuto")}</span>
                    </SelectItem>
                    {TXN_TYPE_OPTIONS.map((tp) => (
                      <SelectItem key={tp} value={tp}>{t(`portfolio.txnType.${tp}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("portfolioImport.requiredNote")}</p>
    </div>
  );
}
