import { useEffect, useRef, useState } from "react";
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
import { CsvColumnMapper } from "@/features/imports/CsvColumnMapper";
import { CsvDropzone } from "@/features/imports/CsvDropzone";
import { FileHeadersPanel } from "@/features/imports/FileHeadersPanel";
import {
    SeparatorSelect,
    EncodingSelect,
    DateFormatSelect,
    NumberFormatSelect,
} from "@/features/imports/CsvFormatSelects";
import { isCsvFile } from "@/features/imports/csvFile";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import {
    Bookmark,
    CheckCircle2,
    Landmark,
    Loader2,
    PencilLine,
    Upload,
    XCircle,
} from "lucide-react";
import { useAdapters } from "./useAdapters";
import {
    useCustomParserConfigs,
    useCreateCustomParserConfig,
    useUpdateCustomParserConfig,
    useDeleteCustomParserConfig,
} from "@/hooks/useCustomParserConfigs";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { consumePendingImportFile } from "@/lib/importHandoff";
import type { ImportProgress, ImportResult } from "@/types/apiClient";
import {
    isReviewRequired,
    type ImportCsvResult,
    type CsvNumberFormat,
} from "@/lib/api/imports";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

interface CustomConfig {
    dateColumn: string;
    dateFormat: string;
    recipientColumn: string;
    amountColumn: string;
    memoColumn: string;
    separator: string;
    encoding: string;
    skipRows: number;
    number_format: CsvNumberFormat;
}

const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
    dateColumn: "",
    dateFormat: "%Y-%m-%d",
    recipientColumn: "",
    amountColumn: "",
    memoColumn: "",
    separator: ",",
    encoding: "utf-8",
    skipRows: 0,
    number_format: "auto",
};

interface TransactionImportCardProps {
    onImportSuccess: () => void;
}

/**
 * Import from your bank: file first, then the bank, then (only for a custom or
 * saved setup) the column mapping. The Import button unlocks once a file and a
 * bank are chosen and, for a custom setup, the three required columns are
 * mapped; the footer names whichever piece is still missing.
 */
export function TransactionImportCard({
    onImportSuccess,
}: TransactionImportCardProps) {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const { adapters, loading: adaptersLoading } = useAdapters();
    const [file, setFile] = useState<File | null>(null);
    const [bankSource, setBankSource] = useState("");
    const [customBank, setCustomBank] = useState("");
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [customConfig, setCustomConfig] = useState<CustomConfig>(
        DEFAULT_CUSTOM_CONFIG,
    );
    const [editingSaved, setEditingSaved] = useState(false);
    const [parserBaseline, setParserBaseline] = useState(() =>
        JSON.stringify({ name: "", config: DEFAULT_CUSTOM_CONFIG }),
    );
    const abortRef = useRef<(() => void) | null>(null);

    const { data: savedParsers } = useCustomParserConfigs();
    const createParser = useCreateCustomParserConfig();
    const updateParser = useUpdateCustomParserConfig();
    const deleteParser = useDeleteCustomParserConfig();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const isSaved = bankSource.startsWith("saved:");
    const selectedParser = isSaved
        ? savedParsers?.find((p) => p.id === Number(bankSource.slice(6)))
        : undefined;
    const isCustomLike = isSaved || bankSource === "custom";
    // Editable config form shows for new custom imports, or when editing a saved parser.
    const showConfigEditor =
        bankSource === "custom" || (isSaved && editingSaved);
    const parserDirty =
        isCustomLike &&
        JSON.stringify({ name: customBank, config: customConfig }) !==
            parserBaseline;
    const { bypassNextNavigation } = useUnsavedChanges(
        file !== null || parserDirty,
    );

    const handleBankChange = (val: string) => {
        setBankSource(val);
        setProgress(null);
        setEditingSaved(false);
        if (val.startsWith("saved:")) {
            const parser = savedParsers?.find(
                (p) => p.id === Number(val.slice(6)),
            );
            if (parser) {
                const nextConfig = {
                    ...DEFAULT_CUSTOM_CONFIG,
                    ...parser.config,
                };
                setCustomConfig(nextConfig);
                setCustomBank(parser.name);
                setParserBaseline(
                    JSON.stringify({ name: parser.name, config: nextConfig }),
                );
            }
        } else if (val === "custom") {
            setCustomConfig(DEFAULT_CUSTOM_CONFIG);
            setCustomBank("");
            setParserBaseline(
                JSON.stringify({ name: "", config: DEFAULT_CUSTOM_CONFIG }),
            );
        }
    };

    const hasRequiredMapping = Boolean(
        customConfig.dateColumn &&
        customConfig.recipientColumn &&
        customConfig.amountColumn,
    );

    const handleSaveParser = async () => {
        const name = customBank.trim();
        if (!name) {
            toast.error(t("importPage.customParser.nameRequired"));
            return;
        }
        if (!hasRequiredMapping) {
            toast.error(t("importPage.toast.noConfig"));
            return;
        }
        const config = { ...customConfig };
        if (isSaved && selectedParser) {
            await updateParser.mutateAsync({
                id: selectedParser.id,
                name,
                config,
            });
            setEditingSaved(false);
        } else {
            const created = await createParser.mutateAsync({ name, config });
            setBankSource(`saved:${created.id}`);
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
            confirmLabel: t("importPage.customParser.delete"),
            variant: "destructive",
        });
        if (!ok) return;
        await deleteParser.mutateAsync(selectedParser.id);
        setBankSource("");
        setCustomBank("");
        setCustomConfig(DEFAULT_CUSTOM_CONFIG);
        setParserBaseline(
            JSON.stringify({ name: "", config: DEFAULT_CUSTOM_CONFIG }),
        );
    };

    // CSV dropped on the window / opened via Finder before this card mounted
    // (see lib/importHandoff.ts + ElectronBridge).
    useEffect(() => {
        const pending = consumePendingImportFile();
        if (pending && isCsvFile(pending)) setFile(pending);
    }, []);

    const resolvedBank = () => {
        if (isSaved) return selectedParser?.name || "generic";
        if (bankSource === "custom") return customBank || "generic";
        return bankSource;
    };

    // What still blocks the import, in the order the card asks for it.
    const hint = (() => {
        if (!file) return t("importPage.hint.file");
        if (!bankSource) return t("importPage.hint.bank");
        if (isCustomLike && !hasRequiredMapping)
            return t("importPage.hint.mapping");
        return "";
    })();
    const canImport = hint === "" && !loading;

    const handleImport = async () => {
        if (!file) {
            toast.error(t("importPage.toast.noFileSel"));
            return;
        }
        const bank = resolvedBank();
        if (!bank) {
            toast.error(t("importPage.toast.noBank"));
            return;
        }
        if (isCustomLike && !hasRequiredMapping) {
            toast.error(t("importPage.toast.noConfig"));
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

        try {
            let data: ImportCsvResult | ImportResult;
            if (isCustomLike) {
                const custom = await apiClient.importCSVCustom(
                    file,
                    bank,
                    customConfig.dateFormat,
                    customConfig.dateColumn,
                    customConfig.recipientColumn,
                    customConfig.amountColumn,
                    customConfig.memoColumn || undefined,
                    customConfig.separator,
                    customConfig.encoding,
                    customConfig.skipRows,
                    customConfig.number_format,
                );
                if (isReviewRequired(custom)) {
                    // 202: the batch is parked in awaiting_review, nothing was committed
                    // and this branch carries no counts at all (`respondReviewRequired`
                    // sends only batch_id / requires_review / match_source_counts). So
                    // there is no completed-progress panel and no "imported N" toast to
                    // show — the review page is the entire outcome.
                    bypassNextNavigation();
                    navigate(`/import/${custom.batch_id}/review`);
                    return;
                }
                // 201: the row count on this route is `total`. It was read as
                // `total_processed` — a field this route has never put on the wire —
                // which is what rendered "undefined total processed" in the toast.
                data = custom;
                setProgress({
                    phase: "complete",
                    current: custom.total,
                    total: custom.total,
                    imported: custom.imported,
                    duplicates: custom.duplicates,
                    errors: custom.errors,
                    percent: 100,
                });
            } else {
                const { abort, result } = apiClient.importCSVWithProgress(
                    file,
                    bank,
                    (p) => setProgress(p),
                );
                abortRef.current = abort;
                data = await result;
                abortRef.current = null;
            }

            if (
                "requires_review" in data &&
                data.requires_review &&
                data.batch_id != null
            ) {
                bypassNextNavigation();
                navigate(`/import/${data.batch_id}/review`);
                return;
            }

            // Both shapes that reach here are committed imports; the SSE result names
            // the row count `total_processed` (importRoutes.js:362) and the
            // non-streaming route names it `total` (buildPipelineResult).
            // (`?? 0` is a type bridge only: every committed SSE result carries
            // total_processed — importResultSchema requires it — the field is just
            // optional on ImportResult for the review-required variant, which
            // returned above.)
            const totalProcessed =
                "total" in data ? data.total : (data.total_processed ?? 0);
            toast.success(
                t("importPage.toast.importSuccess", {
                    n: data.imported,
                    dups: data.duplicates,
                    total: totalProcessed,
                }),
                {
                    icon: <CheckCircle2 className="h-4 w-4" />,
                },
            );
            onImportSuccess();
            setFile(null);
            setBankSource("");
            setCustomBank("");
            setCustomConfig(DEFAULT_CUSTOM_CONFIG);
            setParserBaseline(
                JSON.stringify({ name: "", config: DEFAULT_CUSTOM_CONFIG }),
            );
        } catch (error) {
            toast.error(t("importPage.toast.serverError"), {
                description: apiErrorToMessage(error, t),
            });
            setProgress((p) => (p ? { ...p, phase: "error" } : null));
        } finally {
            setLoading(false);
        }
    };

    const handleCancelImport = () => {
        if (abortRef.current) {
            abortRef.current();
            abortRef.current = null;
            setLoading(false);
            setProgress(null);
            toast.info(t("importPage.toast.importCancelled"));
        }
    };

    const summaryRows: Array<[string, string]> = [
        [t("importPage.dateCol"), customConfig.dateColumn],
        [t("importPage.recipientCol"), customConfig.recipientColumn],
        [t("importPage.amountCol"), customConfig.amountColumn],
        [t("importPage.memoCol"), customConfig.memoColumn || "—"],
        [t("importPage.separator"), customConfig.separator],
        [t("importPage.dateFormat"), customConfig.dateFormat],
        [
            t("importPage.numberFormat.label"),
            t(`importPage.numberFormat.${customConfig.number_format}`),
        ],
    ];

    return (
        <Card className="glass-elevated">
            <CardHeader>
                <CardTitle>{t("importPage.csvImport")}</CardTitle>
                <CardDescription>
                    {t("importPage.csvImportDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* 1. The file */}
                <CsvDropzone
                    file={file}
                    onFileSelect={setFile}
                    label={t("importPage.csvFile")}
                />

                {/* 2. The bank that wrote it */}
                <div className="space-y-2">
                    <Label htmlFor="bank-select">
                        {t("importPage.bankSource")}
                    </Label>
                    <Select value={bankSource} onValueChange={handleBankChange}>
                        <SelectTrigger id="bank-select">
                            <SelectValue
                                placeholder={t(
                                    "importPage.bankSourcePlaceholder",
                                )}
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {adaptersLoading ? (
                                <SelectItem value="loading" disabled>
                                    <Loader2 className="mr-2 inline h-4 w-4" />{" "}
                                    {t("importPage.loading")}
                                </SelectItem>
                            ) : adapters.length > 0 ? (
                                adapters.map((adapter) => (
                                    <SelectItem
                                        key={adapter.key}
                                        value={adapter.key}
                                    >
                                        <span className="inline-flex items-center gap-2">
                                            <Landmark
                                                className="h-3.5 w-3.5 text-label-secondary"
                                                aria-hidden
                                            />
                                            {adapter.name}
                                        </span>
                                    </SelectItem>
                                ))
                            ) : (
                                <SelectItem value="none" disabled>
                                    {t("importPage.noParsers")}
                                </SelectItem>
                            )}
                            {savedParsers &&
                                savedParsers.length > 0 &&
                                savedParsers.map((parser) => (
                                    <SelectItem
                                        key={parser.id}
                                        value={`saved:${parser.id}`}
                                    >
                                        <span className="inline-flex items-center gap-2">
                                            <Bookmark
                                                className="h-3.5 w-3.5 text-primary"
                                                aria-hidden
                                            />
                                            {parser.name}
                                        </span>
                                    </SelectItem>
                                ))}
                            <SelectItem value="custom">
                                <span className="inline-flex items-center gap-2">
                                    <PencilLine
                                        className="h-3.5 w-3.5 text-label-secondary"
                                        aria-hidden
                                    />
                                    {t("importPage.customOther")}
                                </span>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="type-footnote text-label-secondary">
                        {t("importPage.bankHint")}
                    </p>
                </div>

                {/* 3. Custom CSV setup, only when the bank needs one */}
                {isCustomLike && (
                    <section
                        aria-labelledby="custom-setup-title"
                        className="space-y-4 rounded-card corner-continuous bg-foreground/[0.04] p-4"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <h3
                                id="custom-setup-title"
                                className="type-headline text-foreground"
                            >
                                {t("importPage.customConfig")}
                            </h3>
                            {isSaved && !editingSaved && (
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEditingSaved(true)}
                                    >
                                        {t("importPage.customParser.edit")}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:text-destructive"
                                        onClick={handleDeleteParser}
                                        disabled={deleteParser.isPending}
                                    >
                                        {t("importPage.customParser.delete")}
                                    </Button>
                                </div>
                            )}
                        </div>

                        {/* Read-only summary for a selected saved parser */}
                        {isSaved && !editingSaved && (
                            <dl
                                aria-label={t("importPage.savedParserSummary")}
                                className="grid grid-cols-1 gap-x-4 gap-y-1.5 type-footnote sm:grid-cols-2"
                            >
                                {summaryRows.map(([label, value]) => (
                                    <div
                                        key={label}
                                        className="flex min-w-0 justify-between gap-3"
                                    >
                                        <dt className="text-label-secondary">
                                            {label}
                                        </dt>
                                        <dd className="truncate font-medium text-foreground">
                                            {value}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        )}

                        {showConfigEditor && (
                            <>
                                <div className="space-y-2">
                                    <Label htmlFor="parser-name">
                                        {t("importPage.customParser.name")}
                                    </Label>
                                    <Input
                                        id="parser-name"
                                        placeholder={t(
                                            "importPage.customBankName",
                                        )}
                                        value={customBank}
                                        onChange={(e) =>
                                            setCustomBank(e.target.value)
                                        }
                                    />
                                </div>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <SeparatorSelect
                                        id="separator"
                                        value={customConfig.separator}
                                        onChange={(val) =>
                                            setCustomConfig({
                                                ...customConfig,
                                                separator: val,
                                            })
                                        }
                                    />
                                    <DateFormatSelect
                                        id="date-format"
                                        value={customConfig.dateFormat}
                                        onChange={(val) =>
                                            setCustomConfig({
                                                ...customConfig,
                                                dateFormat: val,
                                            })
                                        }
                                    />
                                </div>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <NumberFormatSelect
                                        id="number-format"
                                        value={customConfig.number_format}
                                        onChange={(value) =>
                                            setCustomConfig({
                                                ...customConfig,
                                                number_format: value,
                                            })
                                        }
                                    />
                                    <EncodingSelect
                                        id="encoding"
                                        value={customConfig.encoding}
                                        onChange={(val) =>
                                            setCustomConfig({
                                                ...customConfig,
                                                encoding: val,
                                            })
                                        }
                                    />
                                    <div className="space-y-2">
                                        <Label htmlFor="skip-rows">
                                            {t("importPage.skipRows")}
                                        </Label>
                                        <Input
                                            id="skip-rows"
                                            type="number"
                                            min="0"
                                            placeholder="0"
                                            value={customConfig.skipRows}
                                            onChange={(e) =>
                                                setCustomConfig({
                                                    ...customConfig,
                                                    skipRows:
                                                        parseInt(
                                                            e.target.value,
                                                        ) || 0,
                                                })
                                            }
                                        />
                                    </div>
                                </div>

                                <CsvColumnMapper
                                    file={file}
                                    separator={customConfig.separator}
                                    encoding={customConfig.encoding}
                                    skipRows={customConfig.skipRows}
                                    config={{
                                        dateColumn: customConfig.dateColumn,
                                        recipientColumn:
                                            customConfig.recipientColumn,
                                        amountColumn: customConfig.amountColumn,
                                        memoColumn: customConfig.memoColumn,
                                    }}
                                    onChange={(cols) =>
                                        setCustomConfig({
                                            ...customConfig,
                                            ...cols,
                                        })
                                    }
                                />
                                <p className="type-footnote text-label-secondary">
                                    {t("importPage.requiredNote")}
                                </p>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        onClick={handleSaveParser}
                                        disabled={
                                            createParser.isPending ||
                                            updateParser.isPending ||
                                            !hasRequiredMapping ||
                                            !customBank.trim()
                                        }
                                    >
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
                                            onClick={() => {
                                                setEditingSaved(false);
                                                if (selectedParser) {
                                                    setCustomConfig({
                                                        ...DEFAULT_CUSTOM_CONFIG,
                                                        ...selectedParser.config,
                                                    });
                                                    setCustomBank(
                                                        selectedParser.name,
                                                    );
                                                }
                                            }}
                                        >
                                            {t("common.cancel")}
                                        </Button>
                                    )}
                                </div>
                            </>
                        )}
                    </section>
                )}

                {/* Detected columns of the selected file (always shown once a file is chosen) */}
                <FileHeadersPanel
                    file={file}
                    encoding={isCustomLike ? customConfig.encoding : undefined}
                    skipRows={isCustomLike ? customConfig.skipRows : 0}
                    separator={
                        isCustomLike ? customConfig.separator : undefined
                    }
                    highlightedHeaders={
                        isCustomLike
                            ? [
                                  customConfig.dateColumn,
                                  customConfig.recipientColumn,
                                  customConfig.amountColumn,
                                  customConfig.memoColumn,
                              ]
                            : []
                    }
                    defaultCollapsed={isCustomLike}
                />

                {/* Progress indicator */}
                {progress && loading && (
                    <div
                        role="status"
                        aria-live="polite"
                        className="space-y-3 rounded-card corner-continuous bg-foreground/[0.04] p-4"
                    >
                        <div className="flex items-center justify-between type-body">
                            <span className="font-medium text-label-secondary">
                                {progress.phase === "counting" &&
                                    t("importPage.analyzing")}
                                {progress.phase === "parsing" &&
                                    t("importPage.parsingCSV")}
                                {progress.phase === "importing" &&
                                    t("importPage.importingTxns")}
                                {progress.phase === "connecting" &&
                                    t("importPage.connecting")}
                            </span>
                            <span className="font-medium tabular-nums text-foreground">
                                {progress.percent}%
                            </span>
                        </div>
                        <Progress value={progress.percent} className="h-1.5" />
                        {progress.phase === "importing" &&
                            progress.total > 0 && (
                                <div className="flex flex-wrap gap-4 type-footnote text-label-secondary">
                                    <span className="tabular-nums">
                                        {t("importPage.rows", {
                                            current: progress.current,
                                            total: progress.total,
                                        })}
                                    </span>
                                    <span className="text-success">
                                        {t("importPage.imported", {
                                            n: progress.imported,
                                        })}
                                    </span>
                                    <span className="text-warning">
                                        {t("importPage.duplicates", {
                                            n: progress.duplicates,
                                        })}
                                    </span>
                                    {progress.errors > 0 && (
                                        <span className="text-destructive">
                                            {t("importPage.errors", {
                                                n: progress.errors,
                                            })}
                                        </span>
                                    )}
                                </div>
                            )}
                    </div>
                )}

                {/* Import complete summary */}
                {progress && !loading && progress.phase === "complete" && (
                    <div
                        role="status"
                        className="flex items-center gap-3 rounded-card corner-continuous bg-success/10 p-4"
                    >
                        <CheckCircle2
                            className="icon-success-bounce h-5 w-5 shrink-0 text-success"
                            aria-hidden
                        />
                        <div className="type-body">
                            <p className="font-medium text-success">
                                {t("importPage.complete")}
                            </p>
                            <p className="type-footnote text-success">
                                {t("importPage.progressSummary", {
                                    imported: progress.imported,
                                    duplicates: progress.duplicates,
                                    errors: progress.errors,
                                })}
                            </p>
                        </div>
                    </div>
                )}

                {progress && !loading && progress.phase === "error" && (
                    <div
                        role="alert"
                        className="flex items-center gap-3 rounded-card corner-continuous bg-destructive/5 p-4"
                    >
                        <XCircle
                            className="h-5 w-5 shrink-0 text-destructive"
                            aria-hidden
                        />
                        <p className="type-body font-medium text-destructive">
                            {t("importPage.failed")}
                        </p>
                    </div>
                )}

                {/* Footer: what is still missing, then the action */}
                <div className="flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center">
                    <p
                        className="min-w-0 flex-1 type-footnote text-label-secondary"
                        aria-live="polite"
                    >
                        {hint || t("importPage.hint.ready")}
                    </p>
                    <div className="flex gap-2">
                        {loading && (
                            <Button
                                variant="ghost"
                                onClick={handleCancelImport}
                            >
                                {t("importPage.cancelBtn")}
                            </Button>
                        )}
                        <Button onClick={handleImport} disabled={!canImport}>
                            {loading ? (
                                <>
                                    <Loader2
                                        className="h-4 w-4 animate-spin"
                                        aria-hidden
                                    />
                                    {t("importPage.importingBtn")}
                                </>
                            ) : (
                                <>
                                    <Upload className="h-4 w-4" aria-hidden />
                                    {t("importPage.importBtn")}
                                </>
                            )}
                        </Button>
                    </div>
                </div>
                <ConfirmDialog />
            </CardContent>
        </Card>
    );
}
