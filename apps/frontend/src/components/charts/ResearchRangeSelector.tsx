import { ChartPeriodSelector } from "@/components/charts/ChartPeriodSelector";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { ChartRangeOption } from "@/lib/research/ranges";
import type { ResearchRange } from "@/types/research";

interface ResearchRangeSelectorProps {
    readonly options: ReadonlyArray<ChartRangeOption>;
    readonly value: ResearchRange;
    readonly onChange: (option: ChartRangeOption) => void;
    readonly className?: string;
    readonly size?: "sm" | "md";
    readonly "aria-label"?: string;
    readonly "aria-labelledby"?: string;
}

export function ResearchRangeSelector({
    options,
    value,
    onChange,
    className,
    size = "sm",
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
}: ResearchRangeSelectorProps) {
    const { t } = useLanguage();
    const periods = options.map((option) => option.range);
    const labels = Object.fromEntries(
        options.map((option) => [
            option.range,
            t(`research.range.${option.range}`),
        ]),
    ) as Record<ResearchRange, string>;

    return (
        <ChartPeriodSelector
            periods={periods}
            value={value}
            labels={labels}
            className={className}
            size={size}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            onChange={(range) => {
                const option = options.find(
                    (candidate) => candidate.range === range,
                );
                if (option) onChange(option);
            }}
        />
    );
}
