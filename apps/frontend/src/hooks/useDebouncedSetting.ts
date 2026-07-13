/**
 * useDebouncedSetting — debounced persistence of a single settings key.
 *
 * Extracted from BelgianTaxProfileContext, where the profile / snapshots /
 * snapshot-metas each had an identical ~16-line effect (a first-render skip, a
 * loading gate, a debounce timer, and a `saveSetting` with error reporting).
 *
 * Skips the very first render (initial state is loaded from the preloaded
 * settings, not a user edit) and while `isLoading` is true, then debounces the
 * write. Behaviour is intentionally identical to the three original effects.
 */

import { useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';

const PERSIST_DEBOUNCE_MS = 500;

export function useDebouncedSetting<T>(
  key: string,
  value: T,
  isLoading: boolean,
  onError: () => void,
  errorMessage: string,
): void {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (isLoading) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiClient.saveSetting(key, value).catch((err) => {
        logger.error(errorMessage, err);
        onError();
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [value, isLoading, onError, key, errorMessage]);
}
