import { fieldErrorId } from "@/hooks/useFieldErrors";
import { cn } from "@/lib/utils";

/**
 * Inline validation message for one form field.
 *
 * Visually and structurally the `FormMessage` that lived in
 * `components/ui/form.tsx` until 4a671a3 removed it as dead code — same
 * classes, same "id'd paragraph the control points at" contract — but fed by
 * `useFieldErrors` instead of `react-hook-form`, which that file depended on
 * and which is no longer a dependency of this app.
 *
 * Renders nothing while the field is valid, so the happy-path layout is
 * untouched.
 */
export function FieldError({
    field,
    message,
    className,
}: {
    /** The described control's DOM `id`. */
    field: string;
    message?: string;
    className?: string;
}) {
    if (!message) return null;

    return (
        <p
            id={fieldErrorId(field)}
            className={cn("text-xs font-medium leading-relaxed text-destructive", className)}
        >
            {message}
        </p>
    );
}
