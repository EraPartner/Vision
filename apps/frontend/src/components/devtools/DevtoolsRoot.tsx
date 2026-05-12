import { useEffect } from 'react';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useQueryClient } from '@tanstack/react-query';
import { ApiInspector } from './ApiInspector';
import { InspectorToggle } from './InspectorToggle';
import { initQueryMetrics } from '@/lib/devtools/queryMetrics';
import { registerInspectorHotkey } from '@/lib/devtools/devtoolsHotkey';
import { useInspectorOpen } from '@/lib/devtools/devtoolsHotkey';

export function DevtoolsRoot() {
    const queryClient = useQueryClient();
    const isOpen = useInspectorOpen();

    useEffect(() => {
        const cleanupMetrics = initQueryMetrics(queryClient);
        const cleanupHotkey = registerInspectorHotkey();
        return () => {
            cleanupMetrics();
            cleanupHotkey();
        };
    }, [queryClient]);

    return (
        <>
            <ReactQueryDevtools
                initialIsOpen={false}
                buttonPosition="bottom-left"
            />
            <InspectorToggle />
            {isOpen && <ApiInspector />}
        </>
    );
}
