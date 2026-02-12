import {useState} from "react";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {Plus, Loader2} from "lucide-react";
import {useCreateCategory} from "@/hooks/useCategories";

export function AddCategoryDialog() {
    const [open, setOpen] = useState(false);
    const createMutation = useCreateCategory();
    const [form, setForm] = useState({general: "", detail: "", description: ""});

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.general.trim() || !form.detail.trim()) return;

        createMutation.mutate(
            {general: form.general.trim().toUpperCase(), detail: form.detail.trim().toUpperCase(), description: form.description.trim() || undefined},
            {
                onSuccess: () => {
                    setForm({general: "", detail: "", description: ""});
                    setOpen(false);
                },
            }
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> Add Category
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Add Category</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="general">General</Label>
                        <Input id="general" placeholder="e.g. FOOD" value={form.general} onChange={(e) => setForm(f => ({...f, general: e.target.value}))} required />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="detail">Detail</Label>
                        <Input id="detail" placeholder="e.g. GROCERIES" value={form.detail} onChange={(e) => setForm(f => ({...f, detail: e.target.value}))} required />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="description">Description (optional)</Label>
                        <Textarea id="description" placeholder="Category description..." value={form.description} onChange={(e) => setForm(f => ({...f, description: e.target.value}))} />
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={createMutation.isPending}>
                            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                            Create
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
