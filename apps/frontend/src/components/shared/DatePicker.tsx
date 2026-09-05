import { CalendarIcon, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    formatDateWithAppSettings,
    parseAppDateInput,
    weekStartsOnFromSetting,
} from "@/lib/dateUtils";
import type { FieldErrorAria } from "@/hooks/useFieldErrors";
import { enUS, nl } from "date-fns/locale";

type DatePickerProps = FieldErrorAria & {
    value?: Date;
    onChange: (date?: Date) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    buttonClassName?: string;
    align?: "start" | "center" | "end";
    allowClear?: boolean;
    clearLabel?: string;
    portalContainer?: HTMLElement | null;
    /** Put on the trigger, so a <Label htmlFor> and a <FieldError> can reach it. */
    id?: string;
};

export function DatePicker({
    value,
    onChange,
    placeholder,
    disabled,
    className,
    buttonClassName,
    align = "start",
    allowClear = false,
    clearLabel,
    portalContainer,
    id,
    "aria-invalid": ariaInvalid,
    "aria-describedby": ariaDescribedBy,
}: DatePickerProps) {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const formattedDate = value
        ? formatDateWithAppSettings(value, appSettings.dateFormat)
        : placeholder;
    const weekStartsOn = weekStartsOnFromSetting(appSettings.startOfWeek);
    const inputId = useId();
    const inputErrorId = `${inputId}-error`;
    const [draft, setDraft] = useState(() =>
        value ? formatDateWithAppSettings(value, appSettings.dateFormat) : "",
    );
    const [inputError, setInputError] = useState(false);

    useEffect(() => {
        setDraft(
            value
                ? formatDateWithAppSettings(value, appSettings.dateFormat)
                : "",
        );
        setInputError(false);
    }, [appSettings.dateFormat, value]);

    const calendarRange = useMemo(() => {
        const currentYear = new Date().getFullYear();
        const selectedYear = value?.getFullYear();
        const startYear = Math.min(
            currentYear - 100,
            selectedYear ?? currentYear,
        );
        const endYear = Math.max(currentYear + 20, selectedYear ?? currentYear);
        return {
            startMonth: new Date(startYear, 0, 1),
            endMonth: new Date(endYear, 11, 31),
        };
    }, [value]);

    const commitDraft = () => {
        const parsed = parseAppDateInput(draft, appSettings.dateFormat);
        if (!parsed) {
            setInputError(true);
            return;
        }
        setInputError(false);
        setDraft(formatDateWithAppSettings(parsed, appSettings.dateFormat));
        onChange(parsed);
    };

    const handleSelect = (date?: Date) => {
        setInputError(false);
        setDraft(
            date ? formatDateWithAppSettings(date, appSettings.dateFormat) : "",
        );
        onChange(date);
    };

    const handleClear = () => {
        setInputError(false);
        setDraft("");
        onChange(undefined);
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-invalid={ariaInvalid}
                    aria-describedby={ariaDescribedBy}
                    className={cn(
                        "w-full justify-start text-left font-normal",
                        !value && "text-muted-foreground",
                        buttonClassName,
                    )}
                >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    <span className="truncate">{formattedDate}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent
                container={portalContainer}
                className={cn("w-auto p-0", className)}
                align={align}
            >
                <div className="space-y-1.5 border-b p-3">
                    <Label
                        htmlFor={inputId}
                        className="text-xs text-muted-foreground"
                    >
                        {t("datePicker.inputLabel", {
                            format: appSettings.dateFormat,
                        })}
                    </Label>
                    <Input
                        id={inputId}
                        inputMode="numeric"
                        value={draft}
                        placeholder={appSettings.dateFormat}
                        aria-invalid={inputError || undefined}
                        aria-describedby={inputError ? inputErrorId : undefined}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            if (inputError) setInputError(false);
                        }}
                        onBlur={commitDraft}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            event.stopPropagation();
                            commitDraft();
                        }}
                    />
                    {inputError && (
                        <p
                            id={inputErrorId}
                            role="alert"
                            className="text-xs text-destructive"
                        >
                            {t("datePicker.invalidFormat", {
                                format: appSettings.dateFormat,
                            })}
                        </p>
                    )}
                </div>
                <Calendar
                    mode="single"
                    selected={value}
                    onSelect={handleSelect}
                    weekStartsOn={weekStartsOn}
                    locale={language === "nl" ? nl : enUS}
                    captionLayout="dropdown"
                    startMonth={calendarRange.startMonth}
                    endMonth={calendarRange.endMonth}
                    autoFocus
                    className="p-3 pointer-events-auto"
                />
                {allowClear && value && (
                    <div className="border-t p-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-muted-foreground"
                            onClick={handleClear}
                        >
                            <X className="mr-2 h-3.5 w-3.5" />
                            {clearLabel ?? t("common.clear")}
                        </Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
