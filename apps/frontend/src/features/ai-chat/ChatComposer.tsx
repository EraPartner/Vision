import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square, Wrench } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useOllamaModels, useOllamaStatus } from '@/hooks/useOllamaStatus';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

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
    const [value, setValue] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const { data: status } = useOllamaStatus();
    const { data: modelsData } = useOllamaModels(Boolean(status?.ok));
    const models = modelsData ?? [];
    const effectiveModel = model ?? status?.defaultModel ?? '';

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        // Defer the auto-size write-read-write into a rAF so the forced reflow
        // (height='auto' → read scrollHeight → set height) happens off the
        // keystroke's critical path instead of synchronously per character.
        const raf = requestAnimationFrame(() => {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        });
        return () => cancelAnimationFrame(raf);
    }, [value]);

    const canSend = !disabled && !isStreaming && value.trim().length > 0;

    const submit = () => {
        if (!canSend) return;
        onSend(value.trim());
        setValue('');
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    };

    return (
        <div className="glass-thin !border-x-0 !border-b-0 px-4 py-3">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="eyebrow">
                        {t('aiChat.model')}
                    </span>
                    <Select
                        value={effectiveModel}
                        onValueChange={onModelChange}
                        disabled={!status?.ok || models.length === 0}
                    >
                        <SelectTrigger className="h-7 w-auto min-w-[160px] text-xs">
                            <SelectValue placeholder={t('aiChat.selectModel')} />
                        </SelectTrigger>
                        <SelectContent>
                            {models.map((m) => (
                                <SelectItem key={m.name} value={m.name} className="text-xs">
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <button
                        type="button"
                        onClick={() => onUseToolsChange(!useTools)}
                        disabled={isStreaming}
                        aria-pressed={useTools}
                        title={useTools ? t('aiChat.toolsOn') : t('aiChat.toolsOff')}
                        className={cn(
                            'inline-flex h-7 items-center gap-1 rounded-md border px-2 eyebrow transition-colors',
                            useTools
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-border/60 bg-transparent text-muted-foreground hover:bg-muted/40',
                        )}
                    >
                        <Wrench className="h-3 w-3" />
                        {useTools ? t('aiChat.toolsOn') : t('aiChat.toolsOff')}
                    </button>
                </div>
                <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-background/80 p-2 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/60 transition-colors">
                    <Textarea
                        ref={textareaRef}
                        value={value}
                        onChange={(e) => setValue(e.target.value.slice(0, MAX_LEN))}
                        onKeyDown={handleKeyDown}
                        placeholder={t('aiChat.composerPlaceholder')}
                        disabled={disabled || isStreaming}
                        rows={1}
                        className="min-h-[40px] max-h-[200px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    {isStreaming ? (
                        <Button
                            type="button"
                            onClick={onCancel}
                            variant="outline"
                            size="icon"
                            aria-label={t('aiChat.stop')}
                            className="shrink-0"
                        >
                            <Square className="h-4 w-4" />
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            onClick={submit}
                            disabled={!canSend}
                            size="icon"
                            aria-label={t('aiChat.send')}
                            className="shrink-0"
                        >
                            <Send className="h-4 w-4" />
                        </Button>
                    )}
                </div>
                <div className="flex justify-between text-2xs text-muted-foreground/80">
                    <span>{t('aiChat.enterHint')}</span>
                    <span>{value.length}/{MAX_LEN}</span>
                </div>
            </div>
        </div>
    );
}
