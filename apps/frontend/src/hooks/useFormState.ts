/**
 * useFormState — generic typed form state hook.
 *
 * Encapsulates the repetitive pattern of:
 *   const [form, setForm] = useState<T>(initial);
 *   const handleChange = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
 *   const reset = () => setForm(initial);
 *
 * Usage:
 *   const { form, setField, reset, setForm } = useFormState({ name: '', notes: '' });
 *   // then:
 *   <Input value={form.name} onChange={(e) => setField('name', e.target.value)} />
 *   <button onClick={reset}>Reset</button>
 *
 * The `initialValues` reference is captured on mount. If the caller needs to
 * re-initialise based on async data, pass a lazy initialiser or call `setForm`
 * directly after the data resolves.
 */

import { useCallback, useRef, useState } from "react";

export interface UseFormStateReturn<T extends object> {
  /** Current form values. */
  form: T;
  /**
   * Update a single field immutably.
   * Equivalent to `setForm(prev => ({ ...prev, [field]: value }))`.
   */
  setField: <K extends keyof T>(field: K, value: T[K]) => void;
  /** Replace the entire form state. */
  setForm: React.Dispatch<React.SetStateAction<T>>;
  /** Reset form to the initial values provided to the hook. */
  reset: () => void;
  /** True if the current values differ from the initial values (shallow compare). */
  isDirty: boolean;
}

/**
 * Generic typed form state hook.
 *
 * @param initialValues  Initial form field values. Shallow-compared to
 *                       determine `isDirty`. Captured on mount — pass a stable
 *                       reference or a lazy initialiser if values come from
 *                       async data.
 */
export function useFormState<T extends object>(
  initialValues: T,
): UseFormStateReturn<T> {
  // Capture initialValues in a ref so `reset` always restores the original
  // shape even if the caller passes a new object reference each render.
  const initialRef = useRef<T>(initialValues);

  const [form, setForm] = useState<T>(() => ({ ...initialRef.current }));

  const setField = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const reset = useCallback(() => {
    setForm({ ...initialRef.current });
  }, []);

  const isDirty = (Object.keys(form) as (keyof T)[]).some(
    (key) => form[key] !== initialRef.current[key],
  );

  return { form, setField, setForm, reset, isDirty };
}
