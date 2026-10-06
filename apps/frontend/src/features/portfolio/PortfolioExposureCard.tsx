import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Upload } from "lucide-react";
import { apiClient } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/shared/Money";
import {
    portfolioExposureQueryKey,
    usePortfolioExposureQuery,
} from "@/hooks/portfolio/usePortfolioExposure";

type Dimension = "issuer" | "sector" | "issuerCountry";

export function PortfolioExposureCard({ currency }: { currency: string }) {
    const { t } = useLanguage();
    const formatPercent = usePercentFormatter();
    const sourceInputId = useId();
    const queryClient = useQueryClient();
    const [dimension, setDimension] = useState<Dimension>("issuer");
    const [error, setError] = useState<string | null>(null);
    const query = usePortfolioExposureQuery(currency);
    const upsert = useMutation({
        mutationFn: (bundle: unknown) =>
            apiClient.upsertPortfolioExposureSources(bundle),
        onSuccess: () => {
            setError(null);
            queryClient.invalidateQueries({
                queryKey: portfolioExposureQueryKey(),
            });
        },
        onError: (cause) => setError(apiErrorToMessage(cause, t)),
    });
    const selected = query.data?.[dimension];

    const coverage =
        selected && query.data
            ? [
                  {
                      key: "classified",
                      amount: selected.classifiedValue,
                      percent: selected.classifiedWeightPercent,
                      color: "bg-primary",
                  },
                  {
                      key: "unclassified",
                      amount: selected.unclassifiedValue,
                      percent: selected.unclassifiedWeightPercent,
                      color: "bg-muted-foreground/50",
                  },
                  {
                      key: "uncovered",
                      amount: query.data.uncoveredValue,
                      percent: query.data.uncoveredWeightPercent,
                      color: "bg-warning",
                  },
                  {
                      key: "cash",
                      amount: query.data.coveredCashValue,
                      percent: query.data.coveredCashWeightPercent,
                      color: "bg-info",
                  },
              ]
            : [];
    const canChartCoverage =
        Number(query.data?.totalValue) > 0 &&
        coverage.every(
            ({ percent }) =>
                Number.isFinite(Number(percent)) &&
                Number(percent) >= 0 &&
                Number(percent) <= 100,
        ) &&
        Math.abs(
            coverage.reduce((sum, { percent }) => sum + Number(percent), 0) -
                100,
        ) <= 0.05;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("portfolio.exposure.title")}</CardTitle>
                <CardDescription>
                    {t("portfolio.exposure.description")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <div
                    role="group"
                    aria-label={t("portfolio.exposure.dimensionLabel")}
                    className="flex flex-wrap gap-2"
                >
                    {(["issuer", "sector", "issuerCountry"] as const).map(
                        (value) => (
                            <Button
                                key={value}
                                type="button"
                                size="sm"
                                variant={
                                    dimension === value ? "default" : "outline"
                                }
                                aria-pressed={dimension === value}
                                onClick={() => setDimension(value)}
                            >
                                {t(`portfolio.exposure.${value}`)}
                            </Button>
                        ),
                    )}
                </div>
                {query.isLoading && <p role="status">{t("common.loading")}</p>}
                {query.isError && (
                    <div className="flex flex-wrap items-center gap-3">
                        <p role="alert" className="text-sm text-destructive">
                            {apiErrorToMessage(query.error, t)}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={query.isFetching}
                            onClick={() => void query.refetch()}
                        >
                            {t("common.retry")}
                        </Button>
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {query.data && selected && (
                    <>
                        <div className="space-y-3 rounded-lg border bg-muted/10 p-4">
                            <div className="space-y-1">
                                <h3 className="text-sm font-medium">
                                    {t("portfolio.exposure.coverage")}
                                </h3>
                                {(Number(selected.unclassifiedValue) > 0 ||
                                    Number(query.data.uncoveredValue) > 0) && (
                                    <p className="max-w-prose text-sm text-muted-foreground">
                                        {t(
                                            "portfolio.exposure.partialCoverageHint",
                                        )}
                                    </p>
                                )}
                            </div>
                            {canChartCoverage && (
                                <div
                                    aria-hidden="true"
                                    className="flex h-3 overflow-hidden rounded-full bg-muted"
                                >
                                    {coverage.map(({ key, percent, color }) => (
                                        <span
                                            key={key}
                                            className={`h-full shrink-0 ${color}`}
                                            style={{
                                                width: `${Number(percent)}%`,
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                {coverage.map(
                                    ({ key, amount, percent, color }) => (
                                        <div key={key} className="min-w-0 py-1">
                                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                                <span
                                                    aria-hidden="true"
                                                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`}
                                                />
                                                {t(`portfolio.exposure.${key}`)}
                                            </p>
                                            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                                                <span className="text-lg font-semibold tabular-nums">
                                                    <Money
                                                        amount={amount}
                                                        currency={currency}
                                                    />
                                                </span>
                                                <span className="text-sm tabular-nums text-muted-foreground">
                                                    {formatPercent(
                                                        Number(percent),
                                                        {
                                                            digits: 2,
                                                            minDigits: 0,
                                                        },
                                                    )}
                                                </span>
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {t(
                                                    `portfolio.exposure.${key}Hint`,
                                                )}
                                            </p>
                                        </div>
                                    ),
                                )}
                            </div>
                        </div>
                        {query.data.warnings.length > 0 && (
                            <p className="flex items-center gap-2 text-xs text-warning">
                                <AlertTriangle
                                    aria-hidden="true"
                                    className="h-4 w-4"
                                />
                                {t("portfolio.exposure.warnings", {
                                    count: query.data.warnings.length,
                                })}
                            </p>
                        )}
                        {query.data.fundSources.some(
                            (source) => source.stale,
                        ) && (
                            <p className="text-sm text-warning">
                                {t("portfolio.exposure.stale")}:{" "}
                                {query.data.fundSources
                                    .filter((source) => source.stale)
                                    .map((source) => source.investmentName)
                                    .join(", ")}
                            </p>
                        )}
                        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                            {selected.rows.map((row) => (
                                <details
                                    key={row.id}
                                    className="first:rounded-t-lg last:rounded-b-lg"
                                >
                                    <summary className="cursor-pointer rounded-lg p-3 text-sm font-medium hover:bg-muted/40 focus-ring">
                                        <span className="ml-1 inline-flex w-[calc(100%-1.5rem)] flex-wrap items-center justify-between gap-x-4 gap-y-1 align-middle">
                                            <span>{row.label}</span>
                                            <span className="flex items-baseline gap-3 tabular-nums">
                                                <Money
                                                    amount={row.amount}
                                                    currency={currency}
                                                />
                                                <span className="text-muted-foreground">
                                                    {formatPercent(
                                                        Number(
                                                            row.weightPercent,
                                                        ),
                                                        {
                                                            digits: 2,
                                                            minDigits: 0,
                                                        },
                                                    )}
                                                </span>
                                            </span>
                                        </span>
                                    </summary>
                                    <ul className="space-y-2 border-t px-4 py-3 text-sm text-muted-foreground">
                                        {row.contributions.map(
                                            (item, index) => (
                                                <li
                                                    key={`${item.investmentId}-${index}`}
                                                >
                                                    {item.sourceType ===
                                                    "direct"
                                                        ? t(
                                                              "portfolio.exposure.direct",
                                                          )
                                                        : t(
                                                              "portfolio.exposure.fundContribution",
                                                              {
                                                                  fund:
                                                                      item.sourceFundName ??
                                                                      "",
                                                              },
                                                          )}
                                                    : {item.investmentName} ·{" "}
                                                    <Money
                                                        amount={item.amount}
                                                        currency={currency}
                                                    />
                                                    {item.sourceAsOfDate
                                                        ? ` · ${t("portfolio.exposure.sourceAsOf", { date: item.sourceAsOfDate })}`
                                                        : ""}
                                                    {item.stale
                                                        ? ` · ${t("portfolio.exposure.stale")}`
                                                        : ""}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                </details>
                            ))}
                            {selected.rows.length === 0 && (
                                <p className="p-3 text-sm text-muted-foreground">
                                    {t("portfolio.exposure.noneClassified")}
                                </p>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("portfolio.exposure.fxBoundary")}
                        </p>
                    </>
                )}
                <details className="rounded-lg border">
                    <summary className="cursor-pointer rounded-lg p-3 text-sm font-medium focus-ring">
                        {t("portfolio.exposure.sourcesAndImport")}
                    </summary>
                    <div className="space-y-3 border-t p-3">
                        <p className="text-sm text-muted-foreground">
                            {t("portfolio.exposure.sourceBoundary")}
                        </p>
                        {query.data && query.data.fundSources.length > 0 && (
                            <ul className="space-y-2 text-sm text-muted-foreground">
                                {query.data.fundSources.map((source) => (
                                    <li key={source.investmentId}>
                                        {source.investmentName} ·{" "}
                                        {t("portfolio.exposure.sourceStatus", {
                                            date: source.asOfDate,
                                            age: source.ageDays,
                                            maximum: source.maximumAgeDays,
                                        })}
                                        <span
                                            className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs ${source.stale ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"}`}
                                        >
                                            {t(
                                                source.stale
                                                    ? "portfolio.exposure.stale"
                                                    : "portfolio.exposure.fresh",
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <Label
                            htmlFor={sourceInputId}
                            className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-ring/70"
                        >
                            <Upload
                                aria-hidden="true"
                                className="mr-2 h-4 w-4"
                            />
                            {t("portfolio.exposure.importSources")}
                            <input
                                id={sourceInputId}
                                className="sr-only"
                                type="file"
                                accept="application/json,.json"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (!file) return;
                                    if (file.size > 1_000_000) {
                                        setError(
                                            t(
                                                "portfolio.exposure.invalidSource",
                                            ),
                                        );
                                        return;
                                    }
                                    void file
                                        .text()
                                        .then((text) =>
                                            upsert.mutate(JSON.parse(text)),
                                        )
                                        .catch((cause) =>
                                            setError(
                                                cause instanceof Error
                                                    ? cause.message
                                                    : t(
                                                          "portfolio.exposure.invalidSource",
                                                      ),
                                            ),
                                        );
                                }}
                            />
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            {t("portfolio.exposure.importHint")}
                        </p>
                    </div>
                </details>
            </CardContent>
        </Card>
    );
}
