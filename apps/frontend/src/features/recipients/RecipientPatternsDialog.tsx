import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiClient } from "@/lib/api";
import type {
    RecipientPattern,
    RecipientPatternCreate,
    RecipientPatternUpdate,
} from "@/lib/api";
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
import { Card, CardContent } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { List, ListRow } from "@/components/ui/list";
import { toast } from "sonner";
import {
    Eye,
    Loader2,
    MoreHorizontal,
    Pencil,
    Plus,
    Regex,
    Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { cn } from "@/lib/utils";
import { useRecipientPatterns } from "@/hooks/useRecipients";

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

    const previewVersion = useRef(0);

    useEffect(() => {
        previewVersion.current += 1;
        setPreviewCount(null);
        setIsPreviewing(false);
        return () => {
            previewVersion.current += 1;
        };
    }, [
        form.pattern,
        form.pattern_kind,
        form.case_sensitive,
        editingId,
        addingNew,
        open,
        recipientId,
    ]);

    const queryKey = ["recipient-patterns", recipientId];

    const { data, isLoading } = useRecipientPatterns(recipientId, open);

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
        mutationFn: ({
            patternId,
            data,
        }: {
            patternId: number;
            data: RecipientPatternUpdate;
        }) => apiClient.updateRecipientPattern(recipientId, patternId, data),
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
        if (!form.pattern.trim()) return;
        const version = ++previewVersion.current;
        setIsPreviewing(true);
        try {
            const result = await apiClient.previewRecipientPattern(
                recipientId,
                {
                    pattern: form.pattern.trim(),
                    pattern_kind: form.pattern_kind,
                    case_sensitive: form.case_sensitive,
                },
            );
            if (version === previewVersion.current)
                setPreviewCount(result.matchCount);
        } catch {
            if (version === previewVersion.current)
                toast.error(t("recipientPatterns.toast.error"));
        } finally {
            if (version === previewVersion.current) setIsPreviewing(false);
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

    const kindLabel: Record<PatternKind, string> = {
        literal_prefix: t("recipientPatterns.kindLiteralPrefix"),
        glob: t("recipientPatterns.kindGlob"),
        regex: t("recipientPatterns.kindRegex"),
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {t("recipientPatterns.title")}
                        </DialogTitle>
                        <DialogDescription>
                            <span className="font-medium text-foreground">
                                {recipientName}
                            </span>
                            {" — "}
                            {t("recipientPatterns.subtitle")}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {isLoading ? (
                            <SectionLoader />
                        ) : patterns.length === 0 && !showForm ? (
                            <EmptyState
                                size="compact"
                                icon={Regex}
                                title={t("recipientPatterns.empty")}
                            />
                        ) : patterns.length > 0 ? (
                            <List>
                                {patterns.map((p) => (
                                    <ListRow
                                        key={p.id}
                                        className={cn(
                                            editingId === p.id &&
                                                "bg-primary/12",
                                            !p.is_active && "opacity-60",
                                        )}
                                        title={
                                            <span className="flex flex-wrap items-center gap-2">
                                                <code className="break-all font-mono type-callout">
                                                    {p.pattern}
                                                </code>
                                                <Badge
                                                    variant="outline"
                                                    size="sm"
                                                >
                                                    {kindLabel[p.pattern_kind]}
                                                </Badge>
                                                {p.case_sensitive && (
                                                    <Badge
                                                        variant="outline"
                                                        size="sm"
                                                        title={t(
                                                            "recipientPatterns.caseSensitive",
                                                        )}
                                                    >
                                                        Aa
                                                    </Badge>
                                                )}
                                                {p.source !== "user" && (
                                                    <Badge
                                                        variant="secondary"
                                                        size="sm"
                                                    >
                                                        {p.source}
                                                    </Badge>
                                                )}
                                            </span>
                                        }
                                        subtitle={p.notes || undefined}
                                        trailing={
                                            <span className="flex items-center gap-1">
                                                <Switch
                                                    checked={p.is_active}
                                                    onCheckedChange={() =>
                                                        handleToggleActive(p)
                                                    }
                                                    disabled={
                                                        updateMutation.isPending
                                                    }
                                                    aria-label={t(
                                                        "recipientPatterns.activeFor",
                                                        { pattern: p.pattern },
                                                    )}
                                                />
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger
                                                        asChild
                                                    >
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-8 w-8 text-label-secondary"
                                                            aria-label={t(
                                                                "recipientPatterns.rowMenu",
                                                                {
                                                                    pattern:
                                                                        p.pattern,
                                                                },
                                                            )}
                                                        >
                                                            <MoreHorizontal
                                                                aria-hidden
                                                            />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        <DropdownMenuItem
                                                            onSelect={() =>
                                                                editingId ===
                                                                p.id
                                                                    ? resetForm()
                                                                    : startEdit(
                                                                          p,
                                                                      )
                                                            }
                                                        >
                                                            <Pencil
                                                                className="mr-2 h-4 w-4 text-label-secondary"
                                                                aria-hidden
                                                            />
                                                            {t("common.edit")}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            className="text-destructive focus:text-destructive"
                                                            disabled={
                                                                deleteMutation.isPending
                                                            }
                                                            onSelect={() =>
                                                                void handleDelete(
                                                                    p,
                                                                )
                                                            }
                                                        >
                                                            <Trash2
                                                                className="mr-2 h-4 w-4"
                                                                aria-hidden
                                                            />
                                                            {t("common.delete")}
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </span>
                                        }
                                    />
                                ))}
                            </List>
                        ) : null}

                        {/* Inline add/edit form */}
                        {showForm && (
                            <Card>
                                <CardContent variant="compact">
                                    <form
                                        onSubmit={handleSave}
                                        className="space-y-4"
                                    >
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div className="sm:col-span-2 space-y-2">
                                                <Label htmlFor="pattern-input">
                                                    {t(
                                                        "recipientPatterns.patternLabel",
                                                    )}
                                                </Label>
                                                <div className="flex gap-2">
                                                    <Input
                                                        id="pattern-input"
                                                        value={form.pattern}
                                                        onChange={(e) => {
                                                            setForm({
                                                                ...form,
                                                                pattern:
                                                                    e.target
                                                                        .value,
                                                            });
                                                            setPreviewCount(
                                                                null,
                                                            );
                                                        }}
                                                        placeholder={t(
                                                            "recipientPatterns.patternPlaceholder",
                                                        )}
                                                        className="font-mono"
                                                        autoFocus
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        className="shrink-0"
                                                        onClick={handlePreview}
                                                        disabled={
                                                            !form.pattern.trim() ||
                                                            isPreviewing
                                                        }
                                                    >
                                                        {isPreviewing ? (
                                                            <Loader2
                                                                className="animate-spin"
                                                                aria-hidden
                                                            />
                                                        ) : (
                                                            <Eye aria-hidden />
                                                        )}
                                                        {t(
                                                            "recipientPatterns.previewBtn",
                                                        )}
                                                    </Button>
                                                </div>
                                                {previewCount != null && (
                                                    <p
                                                        role="status"
                                                        className={cn(
                                                            "type-footnote",
                                                            previewCount > 0
                                                                ? "text-primary"
                                                                : "text-label-secondary",
                                                        )}
                                                    >
                                                        {previewCount > 0
                                                            ? t(
                                                                  "recipientPatterns.previewCount",
                                                                  {
                                                                      n: previewCount,
                                                                  },
                                                              )
                                                            : t(
                                                                  "recipientPatterns.previewZero",
                                                              )}
                                                    </p>
                                                )}
                                            </div>

                                            <div className="space-y-2">
                                                <Label htmlFor="pattern-kind">
                                                    {t(
                                                        "recipientPatterns.kindLabel",
                                                    )}
                                                </Label>
                                                <Select
                                                    value={form.pattern_kind}
                                                    onValueChange={(v) =>
                                                        setForm({
                                                            ...form,
                                                            pattern_kind:
                                                                v as PatternKind,
                                                        })
                                                    }
                                                >
                                                    <SelectTrigger id="pattern-kind">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="literal_prefix">
                                                            {t(
                                                                "recipientPatterns.kindLiteralPrefix",
                                                            )}
                                                        </SelectItem>
                                                        <SelectItem value="glob">
                                                            {t(
                                                                "recipientPatterns.kindGlob",
                                                            )}
                                                        </SelectItem>
                                                        <SelectItem value="regex">
                                                            {t(
                                                                "recipientPatterns.kindRegex",
                                                            )}
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="space-y-2">
                                                <Label htmlFor="pattern-priority">
                                                    {t(
                                                        "recipientPatterns.priorityLabel",
                                                    )}
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
                                                            priority:
                                                                parseInt(
                                                                    e.target
                                                                        .value,
                                                                ) || 100,
                                                        })
                                                    }
                                                />
                                            </div>

                                            <div className="sm:col-span-2 space-y-2">
                                                <Label htmlFor="pattern-notes">
                                                    {t(
                                                        "recipientPatterns.notesLabel",
                                                    )}
                                                </Label>
                                                <Input
                                                    id="pattern-notes"
                                                    value={form.notes}
                                                    onChange={(e) =>
                                                        setForm({
                                                            ...form,
                                                            notes: e.target
                                                                .value,
                                                        })
                                                    }
                                                    placeholder={t(
                                                        "recipientPatterns.notesPlaceholder",
                                                    )}
                                                />
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <Switch
                                                    id="pattern-case"
                                                    checked={
                                                        form.case_sensitive
                                                    }
                                                    onCheckedChange={(v) =>
                                                        setForm({
                                                            ...form,
                                                            case_sensitive: v,
                                                        })
                                                    }
                                                />
                                                <Label
                                                    htmlFor="pattern-case"
                                                    className="cursor-pointer"
                                                >
                                                    {t(
                                                        "recipientPatterns.caseSensitive",
                                                    )}
                                                </Label>
                                            </div>
                                        </div>

                                        <div className="flex gap-2 justify-end">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={resetForm}
                                            >
                                                {t("common.cancel")}
                                            </Button>
                                            <Button
                                                type="submit"
                                                disabled={
                                                    !form.pattern.trim() ||
                                                    isSaving
                                                }
                                            >
                                                {isSaving && (
                                                    <Loader2
                                                        className="animate-spin"
                                                        aria-hidden
                                                    />
                                                )}
                                                {t("recipientPatterns.saveBtn")}
                                            </Button>
                                        </div>
                                    </form>
                                </CardContent>
                            </Card>
                        )}

                        {/* Add button */}
                        {!showForm && (
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={() => {
                                    setForm(DEFAULT_FORM);
                                    setAddingNew(true);
                                    setEditingId(null);
                                    setPreviewCount(null);
                                }}
                            >
                                <Plus aria-hidden />
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
