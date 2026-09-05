import { MultiCombobox } from "@/components/shared/MultiCombobox";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface BankAccountMultiComboboxProps {
    value: string[];
    onChange: (ibans: string[]) => void;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
}

const getIban = (iban: string) => iban;

export function BankAccountMultiCombobox({
    value,
    onChange,
    disabled,
    className,
    id,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
}: BankAccountMultiComboboxProps) {
    const { t } = useLanguage();
    const { data } = useBankAccounts();

    const displayLabel =
        value.length === 0
            ? t("combobox.bankAccount.allSelected")
            : t("combobox.bankAccount.nSelected").replace(
                  "{n}",
                  String(value.length),
              );

    return (
        <MultiCombobox
            value={value}
            onChange={onChange}
            items={data ?? []}
            getValue={getIban}
            renderItem={getIban}
            displayLabel={displayLabel}
            searchPlaceholder={t("combobox.bankAccount.search")}
            emptyText={t("combobox.bankAccount.empty")}
            disabled={disabled}
            className={className}
            id={id}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
        />
    );
}
