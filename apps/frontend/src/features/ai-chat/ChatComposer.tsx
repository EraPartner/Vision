import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useOllamaModels, useOllamaStatus } from "@/hooks/useOllamaStatus";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

interface ChatComposerProps {
    onSend: (message: string) => void;
    onCancel: () => void;
    isStreaming: boolean;
    disabled?: boolean;
    model: string | null;
    onModelChange: (model: string) => void;
    useTools: boolean;
    onUseToolsChange: (next: boolean) => void;
}

const MAX_LEN = 4000;

export function ChatComposer({
    onSend,
    onCancel,
    isStreaming,
    disabled = false,
    model,
    onModelChange,
    useTools,
    onUseToolsChange,
}: ChatComposerProps) {
    const { t } = useLanguage();
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const modelId = useId();
    const toolsId = useId();

    const { data: status } = useOllamaStatus();
    const { data: modelsData } = useOllamaModels(Boolean(status?.ok));
    const models = modelsData ?? [];
    const effectiveModel = model ?? status?.defaultModel ?? "";

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        // Defer the auto-size write-read-write into a rAF so the forced reflow
        // (height='auto' → read scrollHeight → set height) happens off the
        // keystroke's critical path instead of synchronously per character.
        const raf = requestAnimationFrame(() => {
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        });
        return () => cancelAnimationFrame(raf);
    }, [value]);

    const canSend = !disabled && !isStreaming && value.trim().length > 0;

    const submit = () => {
        if (!canSend) return;
        onSend(value.trim());
        setValue("");
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    };

    return (
        <div className="border-t border-border/60 bg-card px-4 py-3">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-2">
                        <Label
                            htmlFor={modelId}
                            className="type-footnote text-label-secondary"
                        >
                            {t("aiChat.model")}
                        </Label>
                        <Select
                            value={effectiveModel}
                            onValueChange={onModelChange}
                            disabled={!status?.ok || models.length === 0}
                        >
                            <SelectTrigger
                                id={modelId}
                                className="h-8 w-auto min-w-40"
                            >
                                <SelectValue
                                    placeholder={t("aiChat.selectModel")}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {models.map((m) => (
                                    <SelectItem key={m.name} value={m.name}>
                                        {m.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-center gap-2">
                        <Switch
                            id={toolsId}
                            checked={useTools}
                            onCheckedChange={onUseToolsChange}
                            disabled={disabled || isStreaming}
                            aria-label={t("aiChat.tools")}
                        />
                        <Label
                            htmlFor={toolsId}
                            className="type-footnote text-label-secondary"
                        >
                            {useTools ? t("aiChat.toolsOn") : t("aiChat.toolsOff")}
                        </Label>
                    </div>
                </div>
                <div className="relative">
                    <Textarea
                        ref={textareaRef}
                        value={value}
                        onChange={(e) =>
                            setValue(e.target.value.slice(0, MAX_LEN))
                        }
                        onKeyDown={handleKeyDown}
                        placeholder={t("aiChat.composerPlaceholder")}
                        aria-label={t("aiChat.composerPlaceholder")}
                        disabled={disabled || isStreaming}
                        rows={1}
                        className="max-h-[200px] min-h-11 resize-none py-2.5 pr-14"
                    />
                    <div className="absolute bottom-1 right-1">
                        {isStreaming ? (
                            <Button
                                type="button"
                                onClick={onCancel}
                                variant="outline"
                                size="icon"
                                aria-label={t("aiChat.stop")}
                            >
                                <Square className="h-4 w-4" />
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                onClick={submit}
                                disabled={!canSend}
                                size="icon"
                                aria-label={t("aiChat.send")}
                            >
                                <Send className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                </div>
                <div className="flex justify-between type-caption text-label-tertiary">
                    <span>{t("aiChat.enterHint")}</span>
                    <span className="tabular-nums">
                        {value.length}/{MAX_LEN}
                    </span>
                </div>
            </div>
        </div>
    );
}
