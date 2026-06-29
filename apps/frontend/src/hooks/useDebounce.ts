import { useState, useEffect } from "react";

/**
 * Canonical debounce delay (ms) for search-as-you-type inputs. Long enough to
 * skip intermediate keystrokes during fast typing, short enough to still feel
 * instant. Use this for every search box so the behaviour stays consistent.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Debounce a value by a given delay in milliseconds.
 * Useful for search inputs to avoid excessive API calls.
 */
export function useDebounce<T>(value: T, delay: number = SEARCH_DEBOUNCE_MS): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
