import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * Form state for a dialog whose typed input must survive an accidental
 * dismissal.
 *
 * Radix fires `onOpenChange(false)` for an overlay click and for Escape just as
 * it does for a deliberate close, so dialogs that reset there destroyed every
 * typed field on a stray mis-click. These dialogs stay mounted while closed
 * (the trigger, or the parent, keeps them in the tree), so simply *not*
 * resetting on dismissal is enough for the input to still be there on reopen —
 * the same reason AddTransactionDialog and PlannedPaymentForm never lost work.
 *
 * `reset()` is therefore reserved for the deliberate exits: a successful submit
 * and the Cancel button.
 *
 * `dirty` flips on the first write and clears on `reset()`. It is deliberately
 * "touched", not a value comparison: typing a character and deleting it again
 * still counts as dirty, which errs toward keeping the user's work.
 */
export function useDialogFormState<T>(makeSeed: () => T): {
    form: T;
    setForm: Dispatch<SetStateAction<T>>;
    reset: () => void;
    dirty: boolean;
} {
    const [form, setFormState] = useState<T>(makeSeed);
    const [dirty, setDirty] = useState(false);

    const setForm: Dispatch<SetStateAction<T>> = (value) => {
        setDirty(true);
        setFormState(value);
    };

    const reset = () => {
        setFormState(makeSeed());
        setDirty(false);
    };

    return { form, setForm, reset, dirty };
}

/**
 * Props a draft-preserving dialog exposes so a parent can own its mounting.
 *
 * The preservation above only holds while the dialog is mounted, so a parent
 * that renders one *inside its own* dialog content destroys the draft on its
 * own dismissal — Radix unmounts content when it closes. Such a parent lifts
 * the dialog out of its content and drives it through these props instead;
 * `open` being supplied also means the dialog renders no `DialogTrigger`, since
 * the control that opens it now lives in the parent.
 */
export interface ControlledDialogProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /**
     * Where focus goes when the dialog closes. Without a `DialogTrigger` Radix
     * has nothing to return focus to and would drop it on the body, so the
     * parent passes the control that opened the dialog.
     */
    returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Open state that is the component's own until a parent supplies `open`.
 *
 * `controlled` is what the dialog checks before rendering its trigger.
 */
export function useControlledOpen({ open, onOpenChange }: ControlledDialogProps): {
    open: boolean;
    setOpen: (next: boolean) => void;
    controlled: boolean;
} {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const controlled = open !== undefined;

    return {
        open: controlled ? open : uncontrolledOpen,
        setOpen: (next: boolean) => {
            if (!controlled) setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        controlled,
    };
}

/** Return-focus handler for a controlled dialog's `DialogContent`. */
export function returnFocusOnClose(
    returnFocusRef: ControlledDialogProps["returnFocusRef"],
): ((event: Event) => void) | undefined {
    if (!returnFocusRef) return undefined;
    // Radix composes this before its own handler and skips that one once the
    // event is default-prevented, so this is the whole close-focus behaviour.
    return (event: Event) => {
        event.preventDefault();
        returnFocusRef.current?.focus();
    };
}

/**
 * Re-seed a dialog's form during render whenever the entity it edits is
 * swapped out from under it.
 *
 * Keeping input across a dismissal must never mean showing entity A's values
 * while the dialog is now pointed at entity B (a reused list row, a new market
 * quote). Comparing the identity against the one the form was seeded from is
 * React's documented "adjust state when a prop changes" — it applies before the
 * browser paints, so no stale frame is ever shown and no effect is needed.
 */
export function useReseedOnIdentityChange(identity: unknown, reseed: () => void): void {
    const [seededIdentity, setSeededIdentity] = useState(identity);

    if (!Object.is(identity, seededIdentity)) {
        setSeededIdentity(identity);
        reseed();
    }
}
