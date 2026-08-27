/**
 * Global backstop toaster for mutation errors nobody else surfaces.
 *
 * Every mutation hook that cares about errors already toasts localized copy via
 * `apiErrorToMessage` in its own `onError`. But a mutation defined WITHOUT an
 * `onError` used to fail silently — the user clicked, nothing happened, and the
 * only trace was a rejected promise in devtools (e.g. the attachment upload in
 * `AttachmentPanel`).
 *
 * This component subscribes to the app QueryClient's `MutationCache` and toasts
 * the mapped, localized message for exactly those unhandled failures. Mounted
 * UNDER `LanguageProvider` (same pattern as `SettingsSaveErrorToaster`)
 * because the module-scope QueryClient in App.tsx cannot reach `t`.
 *
 * Double-toast prevention — the backstop stays quiet when:
 *  • `mutation.options.onError` is set: the hook handles (and usually toasts)
 *    the error itself. Call-site-only handlers (`mutate(vars, { onError })`)
 *    are invisible here, but every such call site in this repo pairs with a
 *    hook-level `onError`, so they are covered by this check too.
 *  • `mutation.meta.suppressErrorToast` is set: the call site surfaces errors
 *    through another channel (`mutateAsync` + try/catch toasts, or an inline
 *    error rendering) that the cache cannot see.
 *
 * The raw error is logged for developers; the toast shows mapped copy only.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useLanguage } from '@/contexts/LanguageContext';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import logger from '@/lib/logger';

// App-wide typing for mutation `meta` (TanStack Query's Register pattern).
declare module '@tanstack/react-query' {
    interface Register {
        mutationMeta: {
            /**
             * Set on mutations whose errors are surfaced outside `onError`
             * (`mutateAsync` + catch, inline error rendering) so the global
             * backstop does not toast the same failure twice.
             */
            suppressErrorToast?: boolean;
        };
    }
}

export function GlobalMutationErrorToaster() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    // Latest-t ref so the cache subscription (established once) always
    // translates with the active locale instead of the mount-time one.
    const tRef = useRef(t);
    useEffect(() => {
        tRef.current = t;
    }, [t]);

    useEffect(() => {
        return queryClient.getMutationCache().subscribe((event) => {
            if (event.type !== 'updated' || event.action.type !== 'error') return;
            const { mutation } = event;
            if (mutation.options.onError || mutation.meta?.suppressErrorToast) return;

            const error: unknown = event.action.error;
            // Keep the raw message for devtools/logs — the toast never shows it.
            logger.error('Unhandled mutation error:', error);

            const translate = tRef.current;
            toast.error(translate('common.error'), {
                description: apiErrorToMessage(error, translate),
            });
        });
    }, [queryClient]);

    return null;
}
