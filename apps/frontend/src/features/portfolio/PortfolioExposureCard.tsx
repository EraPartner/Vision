import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useRef, useState } from "react";
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
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Money } from "@/components/shared/Money";
import {
    portfolioExposureQueryKey,
    usePortfolioExposureQuery,
} from "@/hooks/portfolio/usePortfolioExposure";

type Dimension = "issuer" | "sector" | "issuerCountry";

export function PortfolioExposureCard({ currency }: { currency: string }) {
    const { t } = useLanguage();
    const formatPercent = usePercentFormatter();
    const sourceInputRef = useRef<HTMLInputElement>(null);
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
                      color: "bg-label-tertiary",
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
                <SegmentedControl
                    size="sm"
                    value={dimension}
                    onValueChange={(value) => setDimension(value as Dimension)}
                    aria-label={t("portfolio.exposure.dimensionLabel")}
                >
                    {(["issuer", "sector", "issuerCountry"] as const).map(
                        (value) => (
                            <SegmentedControlItem key={value} value={value}>
                                {t(`portfolio.exposure.${value}`)}
                            </SegmentedControlItem>
                        ),
                    )}
                </SegmentedControl>
                {query.isLoading && (
                    <p
                        role="status"
                        className="type-footnote text-label-secondary"
                    >
                        {t("common.loading")}
                    </p>
                )}
                {query.isError && (
                    <Alert variant="destructive">
                        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                            <span>{apiErrorToMessage(query.error, t)}</span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={query.isFetching}
                                onClick={() => void query.refetch()}
                            >
                                {t("common.retry")}
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}
                {error && (
                    <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                {query.data && selected && (
                    <>
                        <div className="space-y-3 rounded-card corner-continuous bg-foreground/[0.04] p-4">
                            <div className="space-y-1">
                                <h3 className="type-headline">
                                    {t("portfolio.exposure.coverage")}
                                </h3>
                                {(Number(selected.unclassifiedValue) > 0 ||
                                    Number(query.data.uncoveredValue) > 0) && (
                                    <p className="max-w-prose type-footnote text-label-secondary">
                                        {t(
                                            "portfolio.exposure.partialCoverageHint",
                                        )}
                                    </p>
                                )}
                            </div>
                            {canChartCoverage && (
                                <div
                                    aria-hidden="true"
                                    className="flex h-3 overflow-hidden rounded-chip bg-foreground/[0.08]"
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
                                            <p className="flex items-center gap-2 type-caption text-label-secondary">
                                                <span
                                                    aria-hidden="true"
                                                    className={`h-2.5 w-2.5 shrink-0 rounded-chip ${color}`}
                                                />
                                                {t(`portfolio.exposure.${key}`)}
                                            </p>
                                            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                                                <span className="type-title-3 tabular-nums">
                                                    <Money
                                                        amount={amount}
                                                        currency={currency}
                                                    />
                                                </span>
                                                <span className="type-footnote tabular-nums text-label-secondary">
                                                    {formatPercent(
                                                        Number(percent),
                                                        {
                                                            digits: 2,
                                                            minDigits: 0,
                                                        },
                                                    )}
                                                </span>
                                            </p>
                                            <p className="mt-1 type-caption text-label-secondary">
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
                            <p className="flex items-center gap-2 type-footnote text-warning">
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
                            <p className="type-footnote text-warning">
                                {t("portfolio.exposure.stale")}:{" "}
                                {query.data.fundSources
                                    .filter((source) => source.stale)
                                    .map((source) => source.investmentName)
                                    .join(", ")}
                            </p>
                        )}
                        <div className="divide-y divide-border/60 rounded-card corner-continuous border border-border/60">
                            {selected.rows.map((row) => (
                                <Disclosure
                                    key={row.id}
                                    className="first:rounded-t-card last:rounded-b-card"
                                >
                                    <DisclosureSummary className="rounded-card p-3 hover:bg-foreground/[0.04]">
                                        <span className="ml-1 inline-flex w-[calc(100%-1.5rem)] flex-wrap items-center justify-between gap-x-4 gap-y-1 align-middle">
                                            <span>{row.label}</span>
                                            <span className="flex items-baseline gap-3 tabular-nums">
                                                <Money
                                                    amount={row.amount}
                                                    currency={currency}
                                                />
                                                <span className="text-label-secondary">
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
                                    </DisclosureSummary>
                                    <ul className="space-y-2 border-t border-border/60 px-4 py-3 type-footnote text-label-secondary">
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
                                </Disclosure>
                            ))}
                            {selected.rows.length === 0 && (
                                <p className="p-3 type-footnote text-label-secondary">
                                    {t("portfolio.exposure.noneClassified")}
                                </p>
                            )}
                        </div>
                        <p className="type-caption text-label-secondary">
                            {t("portfolio.exposure.fxBoundary")}
                        </p>
                    </>
                )}
                <Disclosure variant="card">
                    <DisclosureSummary className="rounded-card p-3">
                        {t("portfolio.exposure.sourcesAndImport")}
                    </DisclosureSummary>
                    <div className="space-y-3 border-t border-border/60 p-3">
                        <p className="type-footnote text-label-secondary">
                            {t("portfolio.exposure.sourceBoundary")}
                        </p>
                        {query.data && query.data.fundSources.length > 0 && (
                            <ul className="space-y-2 type-footnote text-label-secondary">
                                {query.data.fundSources.map((source) => (
                                    <li key={source.investmentId}>
                                        {source.investmentName} ·{" "}
                                        {t("portfolio.exposure.sourceStatus", {
                                            date: source.asOfDate,
                                            age: source.ageDays,
                                            maximum: source.maximumAgeDays,
                                        })}
                                        <Badge
                                            variant={
                                                source.stale
                                                    ? "warning"
                                                    : "secondary"
                                            }
                                            size="sm"
                                            className="ml-2"
                                        >
                                            {t(
                                                source.stale
                                                    ? "portfolio.exposure.stale"
                                                    : "portfolio.exposure.fresh",
                                            )}
                                        </Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={upsert.isPending}
                            onClick={() => sourceInputRef.current?.click()}
                        >
                            <Upload aria-hidden="true" />
                            {t("portfolio.exposure.importSources")}
                        </Button>
                        <input
                            ref={sourceInputRef}
                            className="hidden"
                            type="file"
                            aria-label={t("portfolio.exposure.importSources")}
                            accept="application/json,.json"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                if (!file) return;
                                if (file.size > 1_000_000) {
                                    setError(
                                        t("portfolio.exposure.invalidSource"),
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
                        <p className="type-caption text-label-secondary">
                            {t("portfolio.exposure.importHint")}
                        </p>
                    </div>
                </Disclosure>
            </CardContent>
        </Card>
    );
}
