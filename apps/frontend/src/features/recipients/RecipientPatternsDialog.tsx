import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import type { RecipientPattern, RecipientPatternCreate, RecipientPatternUpdate } from "@/lib/api";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Eye } from "lucide-react";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { cn } from "@/lib/utils";

type PatternKind = "literal_prefix" | "glob" | "regex";

interface PatternFormState {
    pattern: string;
    pattern_kind: PatternKind;
    case_sensitive: boolean;
    priority: number;
    notes: string;
}

const DEFAULT_FORM: PatternFormState = {
    pattern: "",
    pattern_kind: "literal_prefix",
    case_sensitive: false,
    priority: 100,
    notes: "",
};

interface RecipientPatternsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    recipientId: number;
    recipientName: string;
}

export function RecipientPatternsDialog({
    open,
    onOpenChange,
    recipientId,
    recipientName,
}: RecipientPatternsDialogProps) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const [addingNew, setAddingNew] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState<PatternFormState>(DEFAULT_FORM);
    const [previewCount, setPreviewCount] = useState<number | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);

    const queryKey = ["recipient-patterns", recipientId];

    const { data, isLoading } = useQuery({
        queryKey,
        enabled: open,
        queryFn: () => apiClient.listRecipientPatterns(recipientId),
        staleTime: 30_000,
    });

    const patterns = data?.items ?? [];

    const invalidate = () => queryClient.invalidateQueries({ queryKey });

    const createMutation = useMutation({
        mutationFn: (payload: RecipientPatternCreate) =>
            apiClient.createRecipientPattern(recipientId, payload),
        onSuccess: () => {
            toast.success(t("recipientPatterns.toast.created"));
            resetForm();
            invalidate();
        },
        onError: () => toast.error(t("recipientPatterns.toast.error")),
    });

    const updateMutation = useMutation({
        mutationFn: ({ patternId, data }: { patternId: number; data: RecipientPatternUpdate }) =>
            apiClient.updateRecipientPattern(recipientId, patternId, data),
        onSuccess: () => {
            toast.success(t("recipientPatterns.toast.updated"));
            resetForm();
            invalidate();
        },
        onError: () => toast.error(t("recipientPatterns.toast.error")),
    });

    const deleteMutation = useMutation({
        mutationFn: (patternId: number) =>
            apiClient.deleteRecipientPattern(recipientId, patternId),
        onSuccess: () => {
            toast.success(t("recipientPatterns.toast.deleted"));
            invalidate();
        },
        onError: () => toast.error(t("recipientPatterns.toast.error")),
    });

    const resetForm = () => {
        setForm(DEFAULT_FORM);
        setAddingNew(false);
        setEditingId(null);
        setPreviewCount(null);
    };

    const startEdit = (p: RecipientPattern) => {
        setForm({
            pattern: p.pattern,
            pattern_kind: p.pattern_kind,
            case_sensitive: p.case_sensitive,
            priority: p.priority,
            notes: p.notes ?? "",
        });
        setEditingId(p.id);
        setAddingNew(false);
        setPreviewCount(null);
    };

    const handlePreview = async () => {
        if (!form.pattern) return;
        setIsPreviewing(true);
        try {
            const result = await apiClient.previewRecipientPattern(recipientId, {
                pattern: form.pattern,
                pattern_kind: form.pattern_kind,
                case_sensitive: form.case_sensitive,
            });
            setPreviewCount(result.matchCount);
        } catch {
            toast.error(t("recipientPatterns.toast.error"));
        } finally {
            setIsPreviewing(false);
        }
    };

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.pattern.trim()) return;
        const payload = {
            pattern: form.pattern.trim(),
            pattern_kind: form.pattern_kind,
            case_sensitive: form.case_sensitive,
            priority: form.priority,
            notes: form.notes || undefined,
        };
        if (editingId != null) {
            updateMutation.mutate({ patternId: editingId, data: payload });
        } else {
            createMutation.mutate(payload);
        }
    };

    const handleDelete = async (p: RecipientPattern) => {
        const ok = await confirm({
            title: t("recipientPatterns.deleteTitle"),
            description: t("recipientPatterns.deleteDesc"),
            confirmLabel: t("recipientPatterns.deleteConfirm"),
            variant: "destructive",
        });
        if (ok) deleteMutation.mutate(p.id);
    };

    const handleToggleActive = (p: RecipientPattern) => {
        updateMutation.mutate({
            patternId: p.id,
            data: { is_active: !p.is_active },
        });
    };

    const isSaving = createMutation.isPending || updateMutation.isPending;
    const showForm = addingNew || editingId != null;

    const kindBadgeColor: Record<PatternKind, string> = {
        literal_prefix: "bg-chart-3/15 text-chart-3",
        glob: "bg-chart-4/15 text-chart-4",
        regex: "bg-chart-8/15 text-chart-8",
    };

    const kindLabel: Record<PatternKind, string> = {
        literal_prefix: t("recipientPatterns.kindLiteralPrefix"),
        glob: t("recipientPatterns.kindGlob"),
        regex: t("recipientPatterns.kindRegex"),
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{t("recipientPatterns.title")}</DialogTitle>
                        <DialogDescription>
                            <span className="font-medium text-foreground">{recipientName}</span>
                            {" — "}
                            {t("recipientPatterns.subtitle")}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {/* Pattern list */}
                        {isLoading ? (
                            <SectionLoader />
                        ) : patterns.length === 0 && !showForm ? (
                            <p className="text-sm text-muted-foreground py-4 text-center">
                                {t("recipientPatterns.empty")}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {patterns.map((p) => (
                                    <div
                                        key={p.id}
                                        className={cn(
                                            "flex items-start gap-3 p-3 rounded-lg border",
                                            editingId === p.id
                                                ? "border-primary/50 bg-primary/5"
                                                : "border-border bg-muted/30",
                                            !p.is_active && "opacity-50",
                                        )}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <code className="text-sm font-mono text-foreground break-all">
                                                    {p.pattern}
                                                </code>
                                                <span
                                                    className={cn("text-xs px-1.5 py-0.5 rounded font-medium", kindBadgeColor[p.pattern_kind])}
                                                >
                                                    {kindLabel[p.pattern_kind]}
                                                </span>
                                                {p.case_sensitive && (
                                                    <Badge variant="outline" className="text-xs">Aa</Badge>
                                                )}
                                                {p.source !== "user" && (
                                                    <Badge variant="secondary" className="text-xs">
                                                        {p.source}
                                                    </Badge>
                                                )}
                                            </div>
                                            {p.notes && (
                                                <p className="text-xs text-muted-foreground mt-1">{p.notes}</p>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-1 shrink-0">
                                            <Switch
                                                checked={p.is_active}
                                                onCheckedChange={() => handleToggleActive(p)}
                                                disabled={updateMutation.isPending}
                                                className="scale-75"
                                            />
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                                onClick={() =>
                                                    editingId === p.id ? resetForm() : startEdit(p)
                                                }
                                            >
                                                <span className="sr-only">Edit</span>
                                                <svg className="h-3.5 w-3.5" viewBox="0 0 15 15" fill="none">
                                                    <path
                                                        d="M11.8536 1.14645C11.6583 0.951184 11.3417 0.951184 11.1465 1.14645L3.71455 8.57836C3.62459 8.66832 3.55263 8.77461 3.50251 8.89155L2.04044 12.303C1.9599 12.491 2.00189 12.709 2.14646 12.8536C2.29103 12.9981 2.50905 13.0401 2.69697 12.9596L6.10847 11.4975C6.2254 11.4474 6.3317 11.3754 6.42166 11.2855L13.8536 3.85355C14.0488 3.65829 14.0488 3.34171 13.8536 3.14645L11.8536 1.14645Z"
                                                        fill="currentColor"
                                                    />
                                                </svg>
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                onClick={() => handleDelete(p)}
                                                disabled={deleteMutation.isPending}
                                                aria-label={t("recipientPatterns.deleteTitle")}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Inline add/edit form */}
                        {showForm && (
                            <>
                                <Separator />
                                {/* Real <form>: Enter in the pattern/priority/notes
                                    fields saves. Same block layout as the div it replaces. */}
                                <form onSubmit={handleSave} className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="sm:col-span-2 space-y-2">
                                            <Label htmlFor="pattern-input">
                                                {t("recipientPatterns.patternLabel")}
                                            </Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    id="pattern-input"
                                                    value={form.pattern}
                                                    onChange={(e) => {
                                                        setForm({ ...form, pattern: e.target.value });
                                                        setPreviewCount(null);
                                                    }}
                                                    placeholder={t("recipientPatterns.patternPlaceholder")}
                                                    className="font-mono"
                                                    autoFocus
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="icon"
                                                    className="shrink-0"
                                                    title={t("recipientPatterns.previewBtn")}
                                                    onClick={handlePreview}
                                                    disabled={!form.pattern || isPreviewing}
                                                >
                                                    {isPreviewing ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Eye className="h-4 w-4" />
                                                    )}
                                                </Button>
                                            </div>
                                            {previewCount != null && (
                                                <p className={cn("text-xs", previewCount > 0 ? "text-info" : "text-muted-foreground")}>
                                                    {previewCount > 0
                                                        ? t("recipientPatterns.previewCount", { n: previewCount })
                                                        : t("recipientPatterns.previewZero")}
                                                </p>
                                            )}
                                        </div>

                                        <div className="space-y-2">
                                            <Label htmlFor="pattern-kind">
                                                {t("recipientPatterns.kindLabel")}
                                            </Label>
                                            <Select
                                                value={form.pattern_kind}
                                                onValueChange={(v) =>
                                                    setForm({ ...form, pattern_kind: v as PatternKind })
                                                }
                                            >
                                                <SelectTrigger id="pattern-kind">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="literal_prefix">
                                                        {t("recipientPatterns.kindLiteralPrefix")}
                                                    </SelectItem>
                                                    <SelectItem value="glob">
                                                        {t("recipientPatterns.kindGlob")}
                                                    </SelectItem>
                                                    <SelectItem value="regex">
                                                        {t("recipientPatterns.kindRegex")}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label htmlFor="pattern-priority">
                                                {t("recipientPatterns.priorityLabel")}
                                            </Label>
                                            <Input
                                                id="pattern-priority"
                                                type="number"
                                                min={1}
                                                max={999}
                                                value={form.priority}
                                                onChange={(e) =>
                                                    setForm({
                                                        ...form,
                                                        priority: parseInt(e.target.value) || 100,
                                                    })
                                                }
                                            />
                                        </div>

                                        <div className="sm:col-span-2 space-y-2">
                                            <Label htmlFor="pattern-notes">
                                                {t("recipientPatterns.notesLabel")}
                                            </Label>
                                            <Input
                                                id="pattern-notes"
                                                value={form.notes}
                                                onChange={(e) =>
                                                    setForm({ ...form, notes: e.target.value })
                                                }
                                                placeholder={t("recipientPatterns.notesPlaceholder")}
                                            />
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <Switch
                                                id="pattern-case"
                                                checked={form.case_sensitive}
                                                onCheckedChange={(v) =>
                                                    setForm({ ...form, case_sensitive: v })
                                                }
                                            />
                                            <Label htmlFor="pattern-case" className="cursor-pointer">
                                                {t("recipientPatterns.caseSensitive")}
                                            </Label>
                                        </div>
                                    </div>

                                    <div className="flex gap-2 justify-end">
                                        <Button type="button" variant="ghost" onClick={resetForm}>
                                            {t("recipientPatterns.cancelBtn")}
                                        </Button>
                                        <Button
                                            type="submit"
                                            disabled={!form.pattern.trim() || isSaving}
                                        >
                                            {isSaving && (
                                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                            )}
                                            {t("recipientPatterns.saveBtn")}
                                        </Button>
                                    </div>
                                </form>
                            </>
                        )}

                        {/* Add button */}
                        {!showForm && (
                            <Button
                                variant="outline"
                                className="w-full gap-2"
                                onClick={() => {
                                    setForm(DEFAULT_FORM);
                                    setAddingNew(true);
                                    setEditingId(null);
                                    setPreviewCount(null);
                                }}
                            >
                                <Plus className="h-4 w-4" />
                                {t("recipientPatterns.addBtn")}
                            </Button>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
            <ConfirmDialog />
        </>
    );
}
