import type { ChangeEventHandler } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface IndicatorPeriodInputProps {
  indicator: string;
  period: number;
  onChange: ChangeEventHandler<HTMLInputElement>;
}

export function IndicatorPeriodInput({ indicator, period, onChange }: IndicatorPeriodInputProps) {
  const { t } = useLanguage();

  return (
    <input
      type="number"
      aria-label={t("research.builder.indicatorPeriod", { indicator })}
      value={period}
      min={2}
      onChange={onChange}
      className="w-12 bg-transparent text-center tabular-nums"
    />
  );
}
