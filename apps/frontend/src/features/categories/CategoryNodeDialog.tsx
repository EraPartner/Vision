import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCreateCategoryNode,
    useUpdateCategoryNode,
} from "@/hooks/useCategories";
import type { CategoryNode } from "@/types/api";

interface CategoryNodeDialogProps {
    nodes: CategoryNode[];
    editNode?: CategoryNode;
    initialParentId?: number | null;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function CategoryNodeDialog({
    nodes,
    editNode,
    initialParentId = null,
    open: controlledOpen,
    onOpenChange: controlledOnOpenChange,
}: CategoryNodeDialogProps) {
    const { t } = useLanguage();
    const [localOpen, setLocalOpen] = useState(false);
    const [name, setName] = useState(editNode?.name ?? "");
    const [parentId, setParentId] = useState<number | null>(
        editNode?.parentId ?? initialParentId,
    );
    const [description, setDescription] = useState(editNode?.description ?? "");
    const create = useCreateCategoryNode();
    const update = useUpdateCategoryNode();
    const isPending = create.isPending || update.isPending;
    const open = controlledOpen ?? localOpen;
    const onOpenChange = controlledOnOpenChange ?? setLocalOpen;

    // Moving below oneself or a descendant is not an option. The database
    // still enforces this for concurrent edits and non-UI callers.
    const parentOptions = nodes.filter(
        (node) =>
            node.is_active &&
            (!editNode || !node.pathIds.includes(editNode.id)),
    );

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const normalized = name.trim();
        if (!normalized) return;
        const data = {
            name: normalized,
            parentId,
            description: description.trim() || null,
        };
        const onSuccess = () => {
            if (!editNode) {
                setName("");
                setParentId(null);
                setDescription("");
            }
            onOpenChange(false);
        };
        if (editNode) update.mutate({ id: editNode.id, data }, { onSuccess });
        else create.mutate(data, { onSuccess });
    };

    const content = (
        <DialogContent className="sm:max-w-md">
            <DialogHeader>
                <DialogTitle>
                    {editNode
                        ? t("form.addCategory.editTitle")
                        : t("form.addCategory.title")}
                </DialogTitle>
                <DialogDescription className="sr-only">
                    {editNode
                        ? t("form.addCategory.editTitle")
                        : t("form.addCategory.title")}
                </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="category-node-name">
                        {t("categoriesPage.nodeName")}
                    </Label>
                    <Input
                        id="category-node-name"
                        value={name}
                        maxLength={100}
                        onChange={(event) => setName(event.target.value)}
                        required
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="category-node-parent">
                        {t("categoriesPage.parent")}
                    </Label>
                    <select
                        id="category-node-parent"
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={parentId ?? ""}
                        onChange={(event) =>
                            setParentId(
                                event.target.value
                                    ? Number(event.target.value)
                                    : null,
                            )
                        }
                    >
                        <option value="">{t("categoriesPage.root")}</option>
                        {parentOptions.map((node) => (
                            <option key={node.id} value={node.id}>
                                {node.path.join(" / ")}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="category-node-description">
                        {t("addCat.descriptionOptional")}
                    </Label>
                    <Textarea
                        id="category-node-description"
                        value={description}
                        maxLength={500}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </div>
                <DialogFooter className="pt-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={isPending}>
                        {isPending && (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        )}
                        {editNode ? t("common.save") : t("common.create")}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );

    if (editNode || controlledOpen !== undefined) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                {content}
            </Dialog>
        );
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> {t("form.addCategory.title")}
                </Button>
            </DialogTrigger>
            {content}
        </Dialog>
    );
}
