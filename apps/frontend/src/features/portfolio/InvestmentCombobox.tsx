import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInvestmentsQuery } from "@/hooks/portfolio/useInvestments";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface InvestmentComboboxProps {
  value?: number | null;
  onSelect: (investmentId: number | null, investmentName: string | null) => void;
  disabled?: boolean;
  className?: string;
  portalContainer?: HTMLElement | null;
}

export function InvestmentCombobox({ value, onSelect, disabled, className, portalContainer }: InvestmentComboboxProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { data } = useInvestmentsQuery();

  const investments = useMemo(() => data?.items ?? [], [data?.items]);
  const selected = useMemo(() => investments.find((i) => i.id === value), [investments, value]);
  const displayLabel = selected
    ? (selected.symbol ? `${selected.name} (${selected.symbol})` : selected.name)
    : t("combobox.investment.placeholder");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("justify-between font-normal h-8 text-sm", className)}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent container={portalContainer} className="w-[280px] p-0 z-[200]" align="start">
        <Command>
          <CommandInput placeholder={t("combobox.investment.search")} />
          <CommandList>
            <CommandEmpty>{t("combobox.investment.empty")}</CommandEmpty>
            <CommandGroup>
              {investments.map((inv) => {
                const label = inv.symbol ? `${inv.name} (${inv.symbol})` : inv.name;
                return (
                  <CommandItem
                    key={inv.id}
                    value={`${label} ${inv.id}`}
                    onSelect={() => {
                      onSelect(inv.id, label);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value === inv.id ? "opacity-100" : "opacity-0")} />
                    {label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
