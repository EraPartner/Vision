/**
 * useFormState hook tests.
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFormState } from "./useFormState";

interface TestForm {
  name: string;
  age: number;
  active: boolean;
}

const INITIAL: TestForm = { name: "Alice", age: 30, active: true };

describe("useFormState", () => {
  it("initialises with the provided values", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    expect(result.current.form).toEqual(INITIAL);
    expect(result.current.isDirty).toBe(false);
  });

  it("setField updates a single field immutably", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    act(() => {
      result.current.setField("name", "Bob");
    });

    expect(result.current.form.name).toBe("Bob");
    expect(result.current.form.age).toBe(30);    // unchanged
    expect(result.current.form.active).toBe(true); // unchanged
  });

  it("setField marks form as dirty", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    act(() => {
      result.current.setField("age", 99);
    });

    expect(result.current.isDirty).toBe(true);
  });

  it("reset restores initial values and clears dirty flag", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    act(() => {
      result.current.setField("name", "Charlie");
      result.current.setField("age", 0);
    });
    expect(result.current.isDirty).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.form).toEqual(INITIAL);
    expect(result.current.isDirty).toBe(false);
  });

  it("setForm replaces entire form state", () => {
    const { result } = renderHook(() => useFormState(INITIAL));
    const next: TestForm = { name: "Dave", age: 25, active: false };

    act(() => {
      result.current.setForm(next);
    });

    expect(result.current.form).toEqual(next);
  });

  it("isDirty is false when values equal initial even after setForm", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    act(() => {
      result.current.setForm({ ...INITIAL });
    });

    expect(result.current.isDirty).toBe(false);
  });

  it("supports boolean and number fields", () => {
    const { result } = renderHook(() => useFormState(INITIAL));

    act(() => {
      result.current.setField("active", false);
      result.current.setField("age", 0);
    });

    expect(result.current.form.active).toBe(false);
    expect(result.current.form.age).toBe(0);
    expect(result.current.isDirty).toBe(true);
  });
});
