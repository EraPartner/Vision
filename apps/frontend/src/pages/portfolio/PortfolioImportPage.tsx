/**
 * PortfolioImportPage — import brokerage/exchange CSVs into the portfolio.
 * Maintained formats are detected from their headers, with custom mapping for
 * other CSVs. On a batch that needs review it routes
 * to PortfolioImportReviewPage.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PortfolioCsvColumnMapper } from "@/features/imports/PortfolioCsvColumnMapper";
import { portfolioMappedColumns } from "@/features/imports/portfolioColumnFields";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { FileHeadersPanel } from "@/features/imports/FileHeadersPanel";
import {
    SeparatorSelect,
    EncodingSelect,
    DateFormatSelect,
    NumberFormatSelect,
} from "@/features/imports/CsvFormatSelects";
import { toast } from "sonner";
import {
    Bookmark,
    CheckCircle2,
    Loader2,
    PencilLine,
    Save,
    Trash2,
    Upload,
    XCircle,
} from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { apiClient } from "@/lib/api";
import type { PortfolioCustomConfig } from "@/lib/api/portfolioImports";
import {
    usePortfolioParserConfigs,
    useCreatePortfolioParserConfig,
    useUpdatePortfolioParserConfig,
    useDeletePortfolioParserConfig,
} from "@/hooks/usePortfolioParserConfigs";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import type { ImportProgress } from "@/types/apiClient";
import { isImportCancelled } from "@/lib/api/importCancelled";
import { PageShell } from "@/components/shared/PageShell";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useAccounts } from "@/hooks/useAccounts";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";
import { PortfolioBrokerField } from "@/features/portfolio/PortfolioBrokerField";
import {
    DEFAULT_PORTFOLIO_IMPORT_CONFIG,
    portfolioImportPresetConfig,
    portfolioImportSpecializedHintKey,
} from "./portfolioImportPresets";
import {
    detectPortfolioImportFile,
    resolveDetectedPortfolioAccount,
    type DetectedPortfolioImport,
} from "./portfolioImportDetection";
import { PortfolioImportSession } from "./PortfolioImportSession";

const PortfolioImportIcon = PAGE_ICONS["/portfolio/import"];

export function PortfolioImportPage() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const [file, setFile] = useState<File | null>(null);
    const [source, setSource] = useState("auto");
    const [detecting, setDetecting] = useState(false);
    const [detected, setDetected] = useState<{
        file: File;
        result: DetectedPortfolioImport;
    }>();
    const [detectionFailed, setDetectionFailed] = useState(false);
    const [parserName, setParserName] = useState("");
    const [config, setConfig] = useState<PortfolioCustomConfig>(
        DEFAULT_PORTFOLIO_IMPORT_CONFIG,
    );
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [parserBaseline, setParserBaseline] = useState(() =>
        JSON.stringify({ name: "", config: DEFAULT_PORTFOLIO_IMPORT_CONFIG }),
    );
    const abortRef = useRef<(() => void) | null>(null);
    const detectionGeneration = useRef(0);
    const accountChosenManually = useRef(false);

    const { data: savedParsers } = usePortfolioParserConfigs();
    const { data: accountsData } = useAccounts({ active: "true" });
    const brokerAccounts = useMemo(
        () => activeBrokerAccounts(accountsData?.items ?? []),
        [accountsData?.items],
    );
    const createParser = useCreatePortfolioParserConfig();
    const updateParser = useUpdatePortfolioParserConfig();
    const deleteParser = useDeletePortfolioParserConfig();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const isSaved = source.startsWith("saved:");
    const specializedHintKey = portfolioImportSpecializedHintKey(config.format);
    const isSpecializedFormat = specializedHintKey !== undefined;
    const selectedParser = isSaved
        ? savedParsers?.find((p) => p.id === Number(source.slice(6)))
        : undefined;
    const parserDirty =
        JSON.stringify({ name: parserName, config }) !== parserBaseline;
    const { bypassNextNavigation } = useUnsavedChanges(
        file !== null || parserDirty,
    );

    const hasRequiredMapping = Boolean(
        config.dateColumn &&
        (config.symbolColumn || config.nameColumn) &&
        config.defaultAssetClass,
    );

    useEffect(() => {
        if (source !== "auto") return;
        let cancelled = false;
        const generation = ++detectionGeneration.current;
        const isCurrent = () =>
            !cancelled && generation === detectionGeneration.current;
        setDetected(undefined);
        setDetectionFailed(false);
        if (!file) {
            setDetecting(false);
            return;
        }
        setDetecting(true);
        void detectPortfolioImportFile(file)
            .then((result) => {
                if (!isCurrent()) return;
                setDetected(result ? { file, result } : undefined);
                if (result)
                    setConfig((previous) => ({
                        ...portfolioImportPresetConfig(result.source)!,
                        ...(accountChosenManually.current
                            ? { accountId: previous.accountId }
                            : {}),
                    }));
                else if (file.name.toLowerCase().endsWith(".xlsx"))
                    setDetectionFailed(true);
            })
            .catch(() => {
                if (isCurrent()) setDetectionFailed(true);
            })
            .finally(() => {
                if (isCurrent()) setDetecting(false);
            });
        return () => {
            cancelled = true;
        };
    }, [file, source]);

    useEffect(() => {
        if (
            source !== "auto" ||
            !detected ||
            detected.file !== file ||
            accountChosenManually.current
        )
            return;
        const accountId = resolveDetectedPortfolioAccount(
            detected.result,
            brokerAccounts,
        );
        setConfig((previous) =>
            previous.accountId === accountId
                ? previous
                : { ...previous, accountId },
        );
    }, [brokerAccounts, detected, file, source]);

    const handleFileSelect = (nextFile: File | null) => {
        detectionGeneration.current++;
        accountChosenManually.current = false;
        setFile(nextFile);
        setProgress(null);
        setDetected(undefined);
        setDetectionFailed(false);
        if (source === "auto") {
            setConfig(DEFAULT_PORTFOLIO_IMPORT_CONFIG);
            setDetecting(nextFile !== null);
        }
    };

    const handleSourceChange = (val: string) => {
        detectionGeneration.current++;
        accountChosenManually.current = false;
        setSource(val);
        setDetected(undefined);
        setProgress(null);
        setDetecting(false);
        setDetectionFailed(false);
        if (val.startsWith("saved:")) {
            const parser = savedParsers?.find(
                (p) => p.id === Number(val.slice(6)),
            );
            if (parser) {
                const nextConfig = {
                    ...DEFAULT_PORTFOLIO_IMPORT_CONFIG,
                    ...parser.config,
                };
                setConfig(nextConfig);
                setParserName(parser.name);
                setParserBaseline(
                    JSON.stringify({ name: parser.name, config: nextConfig }),
                );
            }
        } else {
            const nextConfig =
                portfolioImportPresetConfig(val) ??
                DEFAULT_PORTFOLIO_IMPORT_CONFIG;
            setConfig(nextConfig);
            setParserName("");
            setParserBaseline(JSON.stringify({ name: "", config: nextConfig }));
        }
    };

    const handleSaveParser = async () => {
        const name = parserName.trim();
        if (!name) {
            toast.error(t("importPage.customParser.nameRequired"));
            return;
        }
        if (!hasRequiredMapping) {
            toast.error(t("portfolioImport.toast.noMapping"));
            return;
        }
        if (isSpecializedFormat && config.accountId == null) {
            toast.error(t("portfolioImport.toast.brokerAccountRequired"));
            return;
        }
        if (isSaved && selectedParser) {
            await updateParser.mutateAsync({
                id: selectedParser.id,
                name,
                config,
            });
        } else {
            const created = await createParser.mutateAsync({ name, config });
            setSource(`saved:${created.id}`);
        }
        setParserBaseline(JSON.stringify({ name, config }));
    };

    const handleDeleteParser = async () => {
        if (!selectedParser) return;
        const ok = await confirm({
            title: t("importPage.customParser.deleteTitle"),
            description: t("importPage.customParser.deleteConfirm", {
                name: selectedParser.name,
            }),
            variant: "destructive",
        });
        if (!ok) return;
        await deleteParser.mutateAsync(selectedParser.id);
        handleSourceChange("custom");
    };

    const handleImport = async () => {
        if (detecting || detectionFailed) return;
        if (!file) {
            toast.error(t("importPage.toast.noFileSel"));
            return;
        }
        if (!hasRequiredMapping) {
            toast.error(t("portfolioImport.toast.noMapping"));
            return;
        }
        if (isSpecializedFormat && config.accountId == null) {
            toast.error(t("portfolioImport.toast.brokerAccountRequired"));
            return;
        }

        setLoading(true);
        setProgress({
            phase: "connecting",
            current: 0,
            total: 0,
            imported: 0,
            duplicates: 0,
            errors: 0,
            percent: 0,
        });
        const adapterName = isSpecializedFormat
            ? config.format!
            : isSaved && selectedParser
              ? selectedParser.name
              : parserName.trim() || "portfolio_generic";

        try {
            const { abort, result } = apiClient.importPortfolioCSVWithProgress(
                file,
                config,
                adapterName,
                (p) => setProgress(p),
                config.accountId != null
                    ? { isBrokerage: true, accountId: config.accountId }
                    : undefined,
            );
            abortRef.current = abort;
            const data = await result;
            abortRef.current = null;

            if ((data.skipped ?? 0) > 0) {
                toast.warning(
                    t("portfolioImport.toast.rowsSkipped", {
                        n: data.skipped as number,
                    }),
                );
            }

            if (data.requires_review && data.batch_id) {
                bypassNextNavigation();
                navigate(`/portfolio/import/${data.batch_id}/review`);
                return;
            }

            toast.success(
                t("portfolioImport.toast.importSuccess", {
                    n: data.imported,
                    dups: data.duplicates,
                }),
                {
                    icon: <CheckCircle2 className="h-4 w-4" />,
                },
            );
            setFile(null);
            setProgress((p) =>
                p ? { ...p, phase: "complete", percent: 100 } : null,
            );
        } catch (error) {
            // Detect cancellation by type, not by matching the error text: the old
            // `message === "Import cancelled"` sentinel would have started reporting
            // cancelled imports as server errors the moment that string was reworded.
            if (isImportCancelled(error)) {
                toast.info(t("importPage.toast.importCancelled"));
                setProgress(null);
            } else {
                toast.error(t("importPage.toast.serverError"), {
                    description: apiErrorToMessage(error, t),
                });
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
        <PageShell className="mx-auto max-w-3xl space-y-6 p-4">
            <PortfolioImportSession accounts={brokerAccounts} />
            <details className="rounded-card corner-continuous border border-border/60 bg-card/70">
                <summary className="cursor-pointer rounded-card p-4 type-body font-medium focus-ring">
                    {t("portfolioImport.session.advanced")}
                </summary>
                <Card className="rounded-t-none border-x-0 border-b-0 shadow-none">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <PortfolioImportIcon className="h-5 w-5 text-primary" />
                            {t("portfolioImport.title")}
                        </CardTitle>
                        <CardDescription>
                            {t("portfolioImport.desc")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Dropzone */}
                        <CsvDropzone
                            file={file}
                            onFileSelect={handleFileSelect}
                            label={t("portfolioImport.fileLabel")}
                            allowWorkbook
                        />

                        {/* Detected columns of the selected file */}
                        {!isSpecializedFormat && (
                            <FileHeadersPanel
                                file={file}
                                separator={config.separator}
                                encoding={config.encoding}
                                skipRows={config.skipRows}
                                highlightedHeaders={portfolioMappedColumns(
                                    config,
                                )}
                                defaultCollapsed
                            />
                        )}

                        {/* Parser source */}
                        <div className="space-y-2">
                            <Label htmlFor="pf-source">
                                {t("portfolioImport.parserSource")}
                            </Label>
                            <Select
                                value={source}
                                onValueChange={handleSourceChange}
                            >
                                <SelectTrigger id="pf-source">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="auto">
                                        {t("portfolioImport.autoDetect")}
                                    </SelectItem>
                                    <SelectItem value="custom">
                                        <span className="inline-flex items-center gap-2">
                                            <PencilLine className="h-3.5 w-3.5 text-label-secondary" />
                                            {t("portfolioImport.newCustom")}
                                        </span>
                                    </SelectItem>
                                    <SelectItem value="ibkr">
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark className="h-3.5 w-3.5 text-primary" />
                                            {t("portfolioImport.ibkrParser")}
                                        </span>
                                    </SelectItem>
                                    <SelectItem value="kinesis">
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark className="h-3.5 w-3.5 text-primary" />
                                            {t("portfolioImport.kinesisParser")}
                                        </span>
                                    </SelectItem>
                                    <SelectItem value="nexo">
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark className="h-3.5 w-3.5 text-primary" />
                                            {t("portfolioImport.nexoParser")}
                                        </span>
                                    </SelectItem>
                                    <SelectItem value="nexo_pro">
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark className="h-3.5 w-3.5 text-primary" />
                                            {t("portfolioImport.nexoProParser")}
                                        </span>
                                    </SelectItem>
                                    <SelectItem value="saxo">
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark className="h-3.5 w-3.5 text-primary" />
                                            {t("portfolioImport.saxoParser")}
                                        </span>
                                    </SelectItem>
                                    {savedParsers?.map((parser) => (
                                        <SelectItem
                                            key={parser.id}
                                            value={`saved:${parser.id}`}
                                        >
                                            <span className="inline-flex items-center gap-2">
                                                <Bookmark className="h-3.5 w-3.5 text-primary" />
                                                {parser.name}
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {detecting && (
                            <p
                                role="status"
                                className="type-footnote text-label-secondary"
                            >
                                {t("portfolioImport.detecting")}
                            </p>
                        )}
                        {detectionFailed && (
                            <Alert variant="destructive">
                                <XCircle className="h-4 w-4" />
                                <AlertDescription>
                                    {t("portfolioImport.detectionFailed")}
                                </AlertDescription>
                            </Alert>
                        )}

                        {isSpecializedFormat ? (
                            <Alert>
                                <AlertDescription>
                                    {t(specializedHintKey!)}
                                </AlertDescription>
                            </Alert>
                        ) : (
                            <>
                                <details className="rounded-card corner-continuous bg-foreground/[0.04] p-3">
                                    <summary className="cursor-pointer rounded-control type-body font-medium focus-ring">
                                        {t("portfolioImport.formatOptions")}
                                    </summary>
                                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <SeparatorSelect
                                            id="pf-separator"
                                            value={config.separator}
                                            onChange={(v) =>
                                                setConfig({
                                                    ...config,
                                                    separator: v,
                                                })
                                            }
                                        />
                                        <DateFormatSelect
                                            id="pf-date-format"
                                            value={config.dateFormat}
                                            onChange={(v) =>
                                                setConfig({
                                                    ...config,
                                                    dateFormat: v,
                                                })
                                            }
                                        />
                                        <EncodingSelect
                                            id="pf-encoding"
                                            value={config.encoding}
                                            onChange={(v) =>
                                                setConfig({
                                                    ...config,
                                                    encoding: v,
                                                })
                                            }
                                        />
                                        <NumberFormatSelect
                                            id="pf-number-format"
                                            value={
                                                config.number_format ?? "auto"
                                            }
                                            onChange={(value) =>
                                                setConfig({
                                                    ...config,
                                                    number_format: value,
                                                })
                                            }
                                        />
                                        <div className="space-y-2">
                                            <Label htmlFor="pf-skip-rows">
                                                {t("importPage.skipRows")}
                                            </Label>
                                            <Input
                                                id="pf-skip-rows"
                                                type="number"
                                                min="0"
                                                value={config.skipRows}
                                                onChange={(e) =>
                                                    setConfig({
                                                        ...config,
                                                        skipRows: Math.max(
                                                            0,
                                                            parseInt(
                                                                e.target.value,
                                                            ) || 0,
                                                        ),
                                                    })
                                                }
                                            />
                                        </div>
                                    </div>
                                </details>

                                {/* Column mapping */}
                                {file ? (
                                    <PortfolioCsvColumnMapper
                                        file={file}
                                        separator={config.separator}
                                        config={config}
                                        onChange={setConfig}
                                    />
                                ) : (
                                    <p className="type-footnote text-label-secondary">
                                        {t("portfolioImport.chooseFileFirst")}
                                    </p>
                                )}
                            </>
                        )}

                        <PortfolioBrokerField
                            id="pf-broker-account"
                            accounts={brokerAccounts}
                            value={
                                config.accountId == null
                                    ? undefined
                                    : String(config.accountId)
                            }
                            onChange={(value) => {
                                accountChosenManually.current = true;
                                setConfig({
                                    ...config,
                                    accountId: value
                                        ? Number(value)
                                        : undefined,
                                });
                            }}
                            t={t}
                        />

                        {/* Save parser */}
                        <details className="rounded-card corner-continuous bg-foreground/[0.04] p-3">
                            <summary className="cursor-pointer rounded-control type-body font-medium focus-ring">
                                {t("portfolioImport.saveParserOptions")}
                            </summary>
                            <div className="mt-4 flex flex-wrap items-end gap-2">
                                <div className="flex-1 space-y-2 min-w-[160px]">
                                    <Label htmlFor="pf-parser-name">
                                        {t("importPage.customParser.name")}
                                    </Label>
                                    <Input
                                        id="pf-parser-name"
                                        placeholder={t(
                                            "portfolioImport.parserNamePlaceholder",
                                        )}
                                        value={parserName}
                                        onChange={(e) =>
                                            setParserName(e.target.value)
                                        }
                                    />
                                </div>
                                <Button
                                    size="sm"
                                    onClick={handleSaveParser}
                                    disabled={
                                        createParser.isPending ||
                                        updateParser.isPending ||
                                        !hasRequiredMapping ||
                                        !parserName.trim()
                                    }
                                >
                                    <Save />
                                    {isSaved
                                        ? t(
                                              "importPage.customParser.saveChanges",
                                          )
                                        : t("importPage.customParser.save")}
                                </Button>
                                {isSaved && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:text-destructive"
                                        onClick={handleDeleteParser}
                                        disabled={deleteParser.isPending}
                                    >
                                        <Trash2 />
                                        {t("importPage.customParser.delete")}
                                    </Button>
                                )}
                            </div>
                        </details>

                        {/* Progress */}
                        {progress && loading && (
                            <div className="space-y-3 rounded-card corner-continuous bg-foreground/[0.04] p-4">
                                <div className="flex items-center justify-between type-body">
                                    <span className="capitalize text-label-secondary">
                                        {progress.phase}
                                    </span>
                                    <span className="tabular-nums font-medium text-foreground">
                                        {progress.percent}%
                                    </span>
                                </div>
                                <Progress
                                    value={progress.percent}
                                    className="h-2"
                                />
                            </div>
                        )}

                        {progress &&
                            !loading &&
                            progress.phase === "complete" && (
                                <Alert variant="success">
                                    <CheckCircle2 className="h-4 w-4" />
                                    <AlertDescription>
                                        {t("importPage.complete")}
                                    </AlertDescription>
                                </Alert>
                            )}
                        {progress && !loading && progress.phase === "error" && (
                            <Alert variant="destructive">
                                <XCircle className="h-4 w-4" />
                                <AlertDescription>
                                    {t("importPage.failed")}
                                </AlertDescription>
                            </Alert>
                        )}

                        {/* Actions */}
                        <div className="flex justify-end gap-2">
                            {loading && (
                                <Button
                                    variant="outline"
                                    onClick={handleCancel}
                                >
                                    {t("importPage.cancelBtn")}
                                </Button>
                            )}
                            <Button
                                onClick={handleImport}
                                disabled={
                                    !file ||
                                    loading ||
                                    detecting ||
                                    detectionFailed ||
                                    (isSpecializedFormat &&
                                        config.accountId == null)
                                }
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="animate-spin" />
                                        {t("importPage.importingBtn")}
                                    </>
                                ) : (
                                    <>
                                        <Upload />
                                        {t("importPage.importBtn")}
                                    </>
                                )}
                            </Button>
                        </div>
                        <ConfirmDialog />
                    </CardContent>
                </Card>
            </details>
        </PageShell>
    );
}

export default PortfolioImportPage;
