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

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("portfolio.exposure.title")}</CardTitle>
                <CardDescription>
                    {t("portfolio.exposure.description")}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                    {(["issuer", "sector", "issuerCountry"] as const).map(
                        (value) => (
                            <Button
                                key={value}
                                type="button"
                                size="sm"
                                variant={
                                    dimension === value ? "default" : "outline"
                                }
                                onClick={() => setDimension(value)}
                            >
                                {t(`portfolio.exposure.${value}`)}
                            </Button>
                        ),
                    )}
                    <Label
                        htmlFor={sourceInputId}
                        className="ml-auto inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm"
                    >
                        <Upload className="mr-2 h-4 w-4" />
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
                    </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t("portfolio.exposure.importHint")}
                </p>
                {query.isLoading && <p role="status">{t("common.loading")}</p>}
                {query.isError && (
                    <p role="alert" className="text-sm text-destructive">
                        {apiErrorToMessage(query.error, t)}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {query.data && selected && (
                    <>
                        <div className="grid gap-2 text-sm sm:grid-cols-4">
                            <p>
                                {t("portfolio.exposure.classified")}:{" "}
                                <Money
                                    amount={selected.classifiedValue}
                                    currency={currency}
                                />{" "}
                                {`(${selected.classifiedWeightPercent}%)`}
                            </p>
                            <p>
                                {t("portfolio.exposure.unclassified")}:{" "}
                                <Money
                                    amount={selected.unclassifiedValue}
                                    currency={currency}
                                />{" "}
                                {`(${selected.unclassifiedWeightPercent}%)`}
                            </p>
                            <p>
                                {t("portfolio.exposure.uncovered")}:{" "}
                                <Money
                                    amount={query.data.uncoveredValue}
                                    currency={currency}
                                />{" "}
                                {`(${query.data.uncoveredWeightPercent}%)`}
                            </p>
                            <p>
                                {t("portfolio.exposure.cash")}:{" "}
                                <Money
                                    amount={query.data.coveredCashValue}
                                    currency={currency}
                                />{" "}
                                {`(${query.data.coveredCashWeightPercent}%)`}
                            </p>
                        </div>
                        {query.data.warnings.length > 0 && (
                            <p className="flex items-center gap-2 text-xs text-warning">
                                <AlertTriangle className="h-4 w-4" />
                                {t("portfolio.exposure.warnings", {
                                    count: query.data.warnings.length,
                                })}
                            </p>
                        )}
                        {query.data.fundSources.length > 0 && (
                            <ul className="space-y-1 text-xs text-muted-foreground">
                                {query.data.fundSources.map((source) => (
                                    <li key={source.investmentId}>
                                        {source.investmentName} ·{" "}
                                        {t("portfolio.exposure.sourceStatus", {
                                            date: source.asOfDate,
                                            age: source.ageDays,
                                            maximum: source.maximumAgeDays,
                                        })}
                                        {source.stale
                                            ? ` · ${t("portfolio.exposure.stale")}`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="space-y-2">
                            {selected.rows.map((row) => (
                                <details
                                    key={row.id}
                                    className="rounded-md border p-2"
                                >
                                    <summary className="cursor-pointer text-sm font-medium">
                                        {row.label} ·{" "}
                                        <Money
                                            amount={row.amount}
                                            currency={currency}
                                        />{" "}
                                        {`(${row.weightPercent}%)`}
                                    </summary>
                                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
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
                                <p className="text-sm text-muted-foreground">
                                    {t("portfolio.exposure.noneClassified")}
                                </p>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("portfolio.exposure.fxBoundary")}
                        </p>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
