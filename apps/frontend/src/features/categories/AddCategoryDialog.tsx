import {useState} from "react";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {Plus, Loader2} from "lucide-react";
import {useCreateCategory} from "@/hooks/useCategories";
import { useLanguage } from "@/contexts/LanguageContext";

type CategoryFormValues = {
    general: string;
    detail: string;
    description: string;
};

type AddCategoryDialogProps =
    | { mode?: "create" }
    | {
        mode: "edit";
        initialValues: CategoryFormValues;
        open: boolean;
        onOpenChange: (open: boolean) => void;
        onSave: (values: CategoryFormValues) => void;
        isSaving?: boolean;
      };

export function AddCategoryDialog(props: AddCategoryDialogProps = {}) {
    const { t } = useLanguage();
    const isEditMode = props.mode === "edit";
    const editProps = isEditMode ? props : undefined;

    // Create-mode state
    const [createOpen, setCreateOpen] = useState(false);
    const createMutation = useCreateCategory();

    // Initialized once on mount. Parents mount the edit dialog per target
    // (keyed by category id), so a target switch remounts with fresh values —
    // no sync effect, which would revert in-flight edits on parent re-renders.
    const [form, setForm] = useState<CategoryFormValues>(
        isEditMode ? props.initialValues : { general: "", detail: "", description: "" }
    );

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.general.trim() || !form.detail.trim()) return;

        const values: CategoryFormValues = {
            general: form.general.trim().toUpperCase(),
            detail: form.detail.trim().toUpperCase(),
            description: form.description.trim(),
        };

        if (isEditMode) {
            editProps?.onSave(values);
        } else {
            createMutation.mutate(
                { general: values.general, detail: values.detail, description: values.description || undefined },
                {
                    onSuccess: () => {
                        setForm({ general: "", detail: "", description: "" });
                        setCreateOpen(false);
                    },
                }
            );
        }
    };

    const open = editProps?.open ?? createOpen;
    const onOpenChange = editProps?.onOpenChange ?? setCreateOpen;
    const isPending = editProps?.isSaving ?? createMutation.isPending;

    const dialogContent = (
        <DialogContent className="sm:max-w-md">
            <DialogHeader>
                <DialogTitle>
                    {isEditMode ? t('form.addCategory.editTitle') : t('form.addCategory.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                    {isEditMode ? t('form.addCategory.editTitle') : t('form.addCategory.title')}
                </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="cat-general">{t('form.addCategory.general')}</Label>
                    <Input
                        id="cat-general"
                        placeholder={t('addCat.generalPlaceholder')}
                        maxLength={100}
                        value={form.general}
                        onChange={(e) => setForm(f => ({ ...f, general: e.target.value }))}
                        required
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="cat-detail">{t('form.addCategory.detail')}</Label>
                    <Input
                        id="cat-detail"
                        placeholder={t('addCat.detailPlaceholder')}
                        maxLength={100}
                        value={form.detail}
                        onChange={(e) => setForm(f => ({ ...f, detail: e.target.value }))}
                        required
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="cat-description">{t('addCat.descriptionOptional')}</Label>
                    <Textarea
                        id="cat-description"
                        placeholder={t('addCat.descriptionPlaceholder')}
                        maxLength={500}
                        value={form.description}
                        onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                    />
                </div>
                <DialogFooter className="pt-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" disabled={isPending}>
                        {isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                        {isEditMode ? t('common.save') : t('common.create')}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );

    if (isEditMode) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                {dialogContent}
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> {t('form.addCategory.title')}
                </Button>
            </DialogTrigger>
            {dialogContent}
        </Dialog>
    );
}
