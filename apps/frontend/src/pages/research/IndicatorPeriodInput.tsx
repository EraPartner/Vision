import type { ChangeEventHandler } from "react";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface IndicatorPeriodInputProps {
    indicator: string;
    period: number;
    onChange: ChangeEventHandler<HTMLInputElement>;
}

export function IndicatorPeriodInput({
    indicator,
    period,
    onChange,
}: IndicatorPeriodInputProps) {
    const { t } = useLanguage();

    return (
        <Input
            type="number"
            aria-label={t("research.builder.indicatorPeriod", { indicator })}
            value={period}
            min={2}
            onChange={onChange}
            className="h-8 w-20 text-center tabular-nums"
        />
    );
}
