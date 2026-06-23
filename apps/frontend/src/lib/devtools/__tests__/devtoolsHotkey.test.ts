// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  toggleInspector,
  setInspectorOpen,
  useInspectorOpen,
  registerInspectorHotkey,
} from "@/lib/devtools/devtoolsHotkey";

describe("devtoolsHotkey", () => {
  afterEach(() => {
    act(() => setInspectorOpen(false));
  });

  test("toggleInspector flips the open state", () => {
    const { result } = renderHook(() => useInspectorOpen());
    expect(result.current).toBe(false);
    act(() => toggleInspector());
    expect(result.current).toBe(true);
    act(() => toggleInspector());
    expect(result.current).toBe(false);
  });

  test("setInspectorOpen is a no-op when value is unchanged", () => {
    const { result } = renderHook(() => useInspectorOpen());
    act(() => setInspectorOpen(true));
    expect(result.current).toBe(true);
    act(() => setInspectorOpen(true));
    expect(result.current).toBe(true);
  });

  test("Ctrl+Shift+A toggles the inspector and unregister stops it", () => {
    const { result } = renderHook(() => useInspectorOpen());
    const unregister = registerInspectorHotkey();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "A", shiftKey: true, ctrlKey: true }),
      );
    });
    expect(result.current).toBe(true);

    unregister();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "A", shiftKey: true, ctrlKey: true }),
      );
    });
    // Still true — handler removed, no further toggle.
    expect(result.current).toBe(true);
  });

  test("ignores keys without the required modifiers", () => {
    const { result } = renderHook(() => useInspectorOpen());
    const unregister = registerInspectorHotkey();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "A" }));
    });
    expect(result.current).toBe(false);
    unregister();
  });
});
