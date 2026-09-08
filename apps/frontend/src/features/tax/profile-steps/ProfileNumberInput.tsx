import { useEffect, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { parseDecimal } from "@/lib/decimal";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatEditableNumber } from "@/utils/currency";

export type ProfileNumberInputProps = Omit<
    ComponentProps<typeof Input>,
    "type" | "value" | "onChange"
> & {
    value: number | null | undefined;
    onValueChange: (value: number | undefined) => void;
    integer?: boolean;
    allowEmpty?: boolean;
};

function valueText(
    value: number | null | undefined,
    numberFormat: Parameters<typeof formatEditableNumber>[1],
): string {
    return value == null ? "" : formatEditableNumber(value, numberFormat);
}

/**
 * Profile number field with a local text draft. The numeric profile updates on
 * every parseable edit, while transitional input such as `12.` remains visible
 * until blur. External profile changes resync whenever the field is not focused.
 */
export function ProfileNumberInput({
    value,
    onValueChange,
    integer = false,
    allowEmpty = false,
    onFocus,
    onBlur,
    ...inputProps
}: ProfileNumberInputProps) {
    const { appSettings } = useAppSettings();
    const [draft, setDraft] = useState(() =>
        valueText(value, appSettings.numberFormat),
    );
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setDraft(valueText(value, appSettings.numberFormat));
    }, [appSettings.numberFormat, focused, value]);

    const updateDraft = (raw: string) => {
        if (integer && !/^-?\d*$/.test(raw)) return;
        setDraft(raw);

        if (raw === "") {
            onValueChange(allowEmpty ? undefined : 0);
            return;
        }

        const parsed = integer
            ? Number.parseInt(raw, 10)
            : parseDecimal(raw, appSettings.numberFormat, NaN);
        if (Number.isFinite(parsed)) onValueChange(parsed);
    };

    return (
        <Input
            {...inputProps}
            type="text"
            inputMode={integer ? "numeric" : "decimal"}
            pattern={integer ? "-?[0-9]*" : undefined}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onFocus={(event) => {
                setFocused(true);
                onFocus?.(event);
            }}
            onBlur={(event) => {
                setFocused(false);
                setDraft(valueText(value, appSettings.numberFormat));
                onBlur?.(event);
            }}
        />
    );
}
