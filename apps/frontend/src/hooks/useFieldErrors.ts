import { useState } from "react";

/**
 * Submit-time field validation that a screen reader can actually discover.
 *
 * Validation used to be announced only through `toast.error(...)`: transient,
 * detached from the control that failed, and gone by the time anyone went
 * looking. The one primitive that wired `aria-invalid`/`aria-describedby`
 * (`components/ui/form.tsx`) was never imported by a single file and was
 * deleted along with its `react-hook-form` dependency in 4a671a3. This is that
 * association contract rebuilt on plain component state — no form library, no
 * new styling — so any form can adopt it a field at a time.
 *
 * Pair with `<FieldError>` from `@/components/ui/field-error`; both halves are
 * keyed off the control's own `id`:
 *
 *     <Input id="tx_amount" {...fieldErrorProps("tx_amount", visibleErrors.tx_amount)} />
 *     <FieldError field="tx_amount" message={visibleErrors.tx_amount} />
 */

/** Field id → message. A missing (or `undefined`) entry means the field is fine. */
export type FieldErrorMap = Record<string, string | undefined>;

/** ARIA a control accepts so it can be associated with its `<FieldError>`. */
export type FieldErrorAria = {
    "aria-invalid"?: true;
    "aria-describedby"?: string;
};

/** Id of the message element describing the control `field`. */
export const fieldErrorId = (field: string): string => `${field}-error`;

/**
 * Attributes to spread on the control itself.
 *
 * Deliberately empty while the field is valid: an `aria-describedby` pointing
 * at an id that is not in the document is worse than no description at all.
 */
export function fieldErrorProps(field: string, message?: string): FieldErrorAria {
    if (!message) return {};
    return { "aria-invalid": true, "aria-describedby": fieldErrorId(field) };
}

/** Stable identity so an all-valid render doesn't churn consumers. */
const NO_ERRORS: FieldErrorMap = {};

function focusAfterCommit(field: string): void {
    const focus = () => document.getElementById(field)?.focus();
    // Wait for React to commit the `aria-describedby` first — focusing before
    // the attribute lands means the screen reader reads the control without
    // its brand-new message.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else setTimeout(focus, 0);
}

/**
 * @param errors  Recomputed by the caller from current form state on every
 *   render. Messages stay hidden until a submit is actually blocked, so a
 *   half-filled form is never scolded mid-typing — and a message clears the
 *   moment its field is corrected, with no per-input bookkeeping.
 * @param order   Visual field order, so the *first* problem gets focus. Entries
 *   must be the controls' DOM ids.
 */
export function useFieldErrors(
    errors: FieldErrorMap,
    order: readonly string[],
): {
    /** Messages to render — empty until a submit has been blocked. */
    visibleErrors: FieldErrorMap;
    /**
     * Guard for the top of a submit handler; `false` means "stop, form
     * invalid". On failure it reveals the messages and moves focus to the first
     * offending control, which is what makes the association pay off: the
     * screen reader lands on that field and reads its label together with the
     * freshly linked message.
     */
    checkValid: () => boolean;
    /** Forget a revealed error set (successful submit, deliberate reset). */
    resetErrors: () => void;
} {
    const [revealed, setRevealed] = useState(false);
    const firstInvalid = order.find((field) => errors[field]);

    return {
        visibleErrors: revealed ? errors : NO_ERRORS,
        checkValid: () => {
            if (!firstInvalid) return true;
            setRevealed(true);
            focusAfterCommit(firstInvalid);
            return false;
        },
        resetErrors: () => setRevealed(false),
    };
}
