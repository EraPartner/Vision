import { CalendarIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings, weekStartsOnFromSetting } from "@/components/shared/dateUtils";
import type { FieldErrorAria } from "@/hooks/useFieldErrors";

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
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const formattedDate = value ? formatDateWithAppSettings(value, appSettings.dateFormat) : placeholder;
  const weekStartsOn = weekStartsOnFromSetting(appSettings.startOfWeek);

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
      <PopoverContent container={portalContainer} className={cn("w-auto p-0", className)} align={align}>
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          weekStartsOn={weekStartsOn}
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
              onClick={() => onChange(undefined)}
            >
              <X className="mr-2 h-3.5 w-3.5" />
              {clearLabel ?? t('common.clear')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
