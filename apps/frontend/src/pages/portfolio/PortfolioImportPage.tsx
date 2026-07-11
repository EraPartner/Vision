/**
 * PortfolioImportPage — import brokerage/exchange CSVs into the portfolio.
 * Always custom-config driven (no pre-built adapters); mirrors the structure of
 * the budgeting TransactionImportCard. On a batch that needs review it routes
 * to PortfolioImportReviewPage.
 */

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useAccounts } from "@/hooks/useAccounts";
import { isPerAccountHoldingsEnabled } from "@/lib/env";
import { PortfolioCsvColumnMapper } from "@/features/imports/PortfolioCsvColumnMapper";
import { portfolioMappedColumns } from "@/features/imports/portfolioColumnFields";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { FileHeadersPanel } from "@/features/imports/FileHeadersPanel";
import { SeparatorSelect, EncodingSelect, DateFormatSelect } from "@/features/imports/CsvFormatSelects";
import { toast } from "sonner";
import {
  Bookmark, CheckCircle2, Loader2, PencilLine, Save, Trash2, TrendingUp, Upload, XCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api";
import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";
import {
  usePortfolioParserConfigs,
  useCreatePortfolioParserConfig,
  useUpdatePortfolioParserConfig,
  useDeletePortfolioParserConfig,
} from "@/hooks/usePortfolioParserConfigs";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import type { ImportProgress } from "@/lib/api/types";

const DEFAULT_CONFIG: PortfolioCustomConfig = {
  dateColumn: "", typeColumn: "", symbolColumn: "", nameColumn: "",
  unitsColumn: "", priceColumn: "", amountColumn: "", feesColumn: "", taxesColumn: "",
  currencyColumn: "", fxRateColumn: "", noteColumn: "",
  dateFormat: "%Y-%m-%d", separator: ",", encoding: "utf-8", skipRows: 0,
  defaultAssetClass: "stock", defaultType: "buy", typeMapping: {},
};

export function PortfolioImportPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("custom");
  const [parserName, setParserName] = useState("");
  const [config, setConfig] = useState<PortfolioCustomConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  // Brokerage fan-out (ADR-095): treat the file as a full statement (cash + trades)
  // landing on one sleeve account; trades get an ADR-090 cash leg.
  const [isBrokerage, setIsBrokerage] = useState(false);
  const [brokerageAccountId, setBrokerageAccountId] = useState("");
  const { data: accountsData } = useAccounts({ active: "true" });
  const abortRef = useRef<(() => void) | null>(null);

  const { data: savedParsers } = usePortfolioParserConfigs();
  const createParser = useCreatePortfolioParserConfig();
  const updateParser = useUpdatePortfolioParserConfig();
  const deleteParser = useDeletePortfolioParserConfig();
  const { confirm, ConfirmDialog } = useConfirmDialog();

  const isSaved = source.startsWith("saved:");
  const selectedParser = isSaved ? savedParsers?.find((p) => p.id === Number(source.slice(6))) : undefined;

  const hasRequiredMapping = Boolean(
    config.dateColumn && (config.symbolColumn || config.nameColumn) && config.defaultAssetClass,
  );

  const handleSourceChange = (val: string) => {
    setSource(val);
    setProgress(null);
    if (val.startsWith("saved:")) {
      const parser = savedParsers?.find((p) => p.id === Number(val.slice(6)));
      if (parser) {
        setConfig({ ...DEFAULT_CONFIG, ...parser.config });
        setParserName(parser.name);
      }
    } else {
      setConfig(DEFAULT_CONFIG);
      setParserName("");
    }
  };

  const handleSaveParser = async () => {
    const name = parserName.trim();
    if (!name) { toast.error(t("importPage.customParser.nameRequired")); return; }
    if (!hasRequiredMapping) { toast.error(t("portfolioImport.toast.noMapping")); return; }
    if (isSaved && selectedParser) {
      await updateParser.mutateAsync({ id: selectedParser.id, name, config });
    } else {
      const created = await createParser.mutateAsync({ name, config });
      setSource(`saved:${created.id}`);
    }
  };

  const handleDeleteParser = async () => {
    if (!selectedParser) return;
    const ok = await confirm({
      title: t("importPage.customParser.deleteTitle"),
      description: t("importPage.customParser.deleteConfirm", { name: selectedParser.name }),
      variant: "destructive",
    });
    if (!ok) return;
    await deleteParser.mutateAsync(selectedParser.id);
    handleSourceChange("custom");
  };

  const handleImport = async () => {
    if (!file) { toast.error(t("importPage.toast.noFileSel")); return; }
    if (!hasRequiredMapping) { toast.error(t("portfolioImport.toast.noMapping")); return; }
    if (isBrokerage && !brokerageAccountId) { toast.error(t("portfolioImport.brokerage.needAccount")); return; }

    setLoading(true);
    setProgress({ phase: "connecting", current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 0 });
    const adapterName = isSaved && selectedParser ? selectedParser.name : (parserName.trim() || "portfolio_generic");
    const brokerage = isBrokerage ? { isBrokerage: true, accountId: Number(brokerageAccountId) } : undefined;

    try {
      const { abort, result } = apiClient.importPortfolioCSVWithProgress(file, config, adapterName, (p) => setProgress(p), brokerage);
      abortRef.current = abort;
      const data = await result;
      abortRef.current = null;

      if (data.requires_review && data.batch_id) {
        navigate(`/portfolio/import/${data.batch_id}/review`);
        return;
      }

      toast.success(t("portfolioImport.toast.importSuccess", { n: data.imported, dups: data.duplicates }), {
        icon: <CheckCircle2 className="h-4 w-4" />,
      });
      if ((data.skipped ?? 0) > 0) {
        toast.warning(t("portfolioImport.toast.rowsSkipped", { n: data.skipped as number }));
      }
      setFile(null);
      setProgress((p) => (p ? { ...p, phase: "complete", percent: 100 } : null));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("importPage.failed");
      if (message === "Import cancelled") {
        toast.info(t("importPage.toast.importCancelled"));
        setProgress(null);
      } else {
        toast.error(t("importPage.toast.serverError"), { description: message });
        setProgress((p) => (p ? { ...p, phase: "error" } : null));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            {t("portfolioImport.title")}
          </CardTitle>
          <CardDescription>{t("portfolioImport.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Parser source */}
          <div className="space-y-2">
            <Label htmlFor="pf-source" className="font-semibold">{t("portfolioImport.parserSource")}</Label>
            <Select value={source} onValueChange={handleSourceChange}>
              <SelectTrigger id="pf-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">
                  <span className="inline-flex items-center gap-2">
                    <PencilLine className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("portfolioImport.newCustom")}
                  </span>
                </SelectItem>
                {savedParsers?.map((parser) => (
                  <SelectItem key={parser.id} value={`saved:${parser.id}`}>
                    <span className="inline-flex items-center gap-2">
                      <Bookmark className="h-3.5 w-3.5 text-primary" />
                      {parser.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Format options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SeparatorSelect id="pf-separator" value={config.separator} onChange={(v) => setConfig({ ...config, separator: v })} />
            <DateFormatSelect id="pf-date-format" value={config.dateFormat} onChange={(v) => setConfig({ ...config, dateFormat: v })} />
            <EncodingSelect id="pf-encoding" value={config.encoding} onChange={(v) => setConfig({ ...config, encoding: v })} />
            <div className="space-y-2">
              <Label htmlFor="pf-skip-rows">{t("importPage.skipRows")}</Label>
              <Input
                id="pf-skip-rows"
                type="number"
                min="0"
                value={config.skipRows}
                onChange={(e) => setConfig({ ...config, skipRows: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>

          {/* Column mapping */}
          <PortfolioCsvColumnMapper file={file} separator={config.separator} config={config} onChange={setConfig} />

          {/* Save parser */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 space-y-2 min-w-[160px]">
              <Label htmlFor="pf-parser-name">{t("importPage.customParser.name")}</Label>
              <Input
                id="pf-parser-name"
                placeholder={t("portfolioImport.parserNamePlaceholder")}
                value={parserName}
                onChange={(e) => setParserName(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              onClick={handleSaveParser}
              disabled={createParser.isPending || updateParser.isPending || !hasRequiredMapping || !parserName.trim()}
            >
              <Save className="h-4 w-4 mr-1" />
              {isSaved ? t("importPage.customParser.saveChanges") : t("importPage.customParser.save")}
            </Button>
            {isSaved && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDeleteParser} disabled={deleteParser.isPending}>
                <Trash2 className="h-4 w-4 mr-1" /> {t("importPage.customParser.delete")}
              </Button>
            )}
          </div>

          {/* Dropzone */}
          <CsvDropzone file={file} onFileSelect={setFile} label={t("importPage.csvFile")} />

          {/* Detected columns of the selected file */}
          <FileHeadersPanel
            file={file}
            separator={config.separator}
            highlightedHeaders={portfolioMappedColumns(config)}
            defaultCollapsed
          />

          {/* Brokerage fan-out (ADR-095) — gated with per-account holdings (ADR-103) */}
          {isPerAccountHoldingsEnabled && (
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="pf-brokerage" className="text-sm">{t("portfolioImport.brokerage.toggle")}</Label>
                <p className="text-xs text-muted-foreground">{t("portfolioImport.brokerage.hint")}</p>
              </div>
              <Switch id="pf-brokerage" checked={isBrokerage} onCheckedChange={setIsBrokerage} />
            </div>
            {isBrokerage && (
              <div className="space-y-1.5">
                <Label htmlFor="pf-brokerage-account">{t("portfolioImport.review.account")}</Label>
                <Select value={brokerageAccountId} onValueChange={setBrokerageAccountId}>
                  <SelectTrigger id="pf-brokerage-account"><SelectValue placeholder={t("portfolio.move.selectAccount")} /></SelectTrigger>
                  <SelectContent>
                    {(accountsData?.items ?? []).map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.display_name || a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          )}

          {/* Progress */}
          {progress && loading && (
            <div className="space-y-3 p-4 rounded-lg border bg-muted/30">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground font-medium capitalize">{progress.phase}</span>
                <span className="text-foreground font-semibold">{progress.percent}%</span>
              </div>
              <Progress value={progress.percent} className="h-2" />
            </div>
          )}

          {progress && !loading && progress.phase === "complete" && (
            <div className="flex items-center gap-3 p-4 rounded-lg border border-success/30 bg-success/10">
              <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
              <p className="text-sm font-medium text-success">{t("importPage.complete")}</p>
            </div>
          )}
          {progress && !loading && progress.phase === "error" && (
            <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
              <XCircle className="h-5 w-5 text-destructive shrink-0" />
              <p className="text-sm font-medium text-destructive">{t("importPage.failed")}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Button onClick={handleImport} disabled={!file || loading} className="flex-1 h-11" size="lg">
              {loading ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t("importPage.importingBtn")}</>
              ) : (
                <><Upload className="h-4 w-4 mr-2" /> {t("importPage.importBtn")}</>
              )}
            </Button>
            {loading && (
              <Button variant="outline" size="lg" className="h-11" onClick={handleCancel}>
                {t("importPage.cancelBtn")}
              </Button>
            )}
          </div>
          <ConfirmDialog />
        </CardContent>
      </Card>
    </div>
  );
}

export default PortfolioImportPage;
