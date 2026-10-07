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
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useMergeCategoryNode } from "@/hooks/useCategories";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { CategoryNode } from "@/types/api";

interface CategoryMergeDialogProps {
    source: CategoryNode;
    nodes: CategoryNode[];
    onCloseAutoFocus?: () => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function CategoryMergeDialog({
    source,
    nodes,
    onCloseAutoFocus,
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
    const target = targets.find((node) => node.id === targetId);
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
            <DialogContent
                className="sm:max-w-md"
                onCloseAutoFocus={(event) => {
                    if (onCloseAutoFocus) {
                        event.preventDefault();
                        onCloseAutoFocus();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t("categoriesPage.mergeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("categoriesPage.mergeDescription")}
                    </DialogDescription>
                </DialogHeader>
                <form className="space-y-4" onSubmit={submit}>
                    <Card>
                        <CardContent variant="compact">
                            <p className="type-footnote text-label-secondary">
                                {t("categoriesPage.mergeSourceLabel")}
                            </p>
                            <p className="type-body font-medium">
                                {source.path.join(" / ")}
                            </p>
                        </CardContent>
                    </Card>
                    <div className="space-y-2">
                        <Label htmlFor="category-merge-target">
                            {t("categoriesPage.mergeTarget")}
                        </Label>
                        <Select
                            value={
                                targetId == null ? undefined : String(targetId)
                            }
                            onValueChange={(value) =>
                                setTargetId(Number(value))
                            }
                        >
                            <SelectTrigger id="category-merge-target">
                                <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                                {targets.map((node) => (
                                    <SelectItem
                                        key={node.id}
                                        value={String(node.id)}
                                    >
                                        {node.path.join(" / ")}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {target && (
                        <p className="type-callout text-label-secondary">
                            {t("categoriesPage.mergeSelectionSummary", {
                                source: source.path.join(" / "),
                                target: target.path.join(" / "),
                            })}
                        </p>
                    )}
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
                                <Loader2
                                    className="animate-spin"
                                    aria-hidden="true"
                                />
                            )}
                            {t("categoriesPage.mergeConfirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
