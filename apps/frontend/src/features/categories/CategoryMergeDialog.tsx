import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useMergeCategoryNode } from "@/hooks/useCategories";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { CategoryNode } from "@/types/api";

interface CategoryMergeDialogProps {
    source: CategoryNode;
    nodes: CategoryNode[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function CategoryMergeDialog({
    source,
    nodes,
    open,
    onOpenChange,
}: CategoryMergeDialogProps) {
    const { t } = useLanguage();
    const [targetId, setTargetId] = useState<number | null>(null);
    const merge = useMergeCategoryNode();
    const targets = nodes.filter(
        (node) =>
            node.is_active &&
            node.id !== source.id &&
            !node.pathIds.includes(source.id),
    );
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (targetId == null) return;
        merge.mutate(
            { sourceId: source.id, targetId },
            {
                onSuccess: () => onOpenChange(false),
            },
        );
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("categoriesPage.mergeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("categoriesPage.mergeDescription")}
                    </DialogDescription>
                </DialogHeader>
                <form className="space-y-4" onSubmit={submit}>
                    <div className="space-y-2">
                        <Label htmlFor="category-merge-target">
                            {t("categoriesPage.mergeTarget")}
                        </Label>
                        <select
                            id="category-merge-target"
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={targetId ?? ""}
                            onChange={(event) =>
                                setTargetId(
                                    event.target.value
                                        ? Number(event.target.value)
                                        : null,
                                )
                            }
                            required
                        >
                            <option value="">—</option>
                            {targets.map((node) => (
                                <option key={node.id} value={node.id}>
                                    {node.path.join(" / ")}
                                </option>
                            ))}
                        </select>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={merge.isPending || targetId == null}
                        >
                            {merge.isPending && (
                                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            )}
                            {t("categoriesPage.mergeConfirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
