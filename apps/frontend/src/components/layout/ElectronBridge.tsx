import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSidebar } from '@/components/ui/sidebar';
import { useVisualEffectsTier } from '@/hooks/useVisualEffectsTier';
import { getElectronAPI, isElectronMac, type ElectronMenuAction } from '@/lib/api/electron';
import { registerPendingImportFile } from '@/lib/importHandoff';

interface ElectronBridgeProps {
    onOpenSettings: (tab: string) => void;
    onOpenShortcuts: () => void;
}

/**
 * Renderer side of the Electron-native integration (V12). Renders nothing;
 * mounted inside SidebarProvider so menu actions can toggle the sidebar.
 *
 * - Tags <html> with `electron-mac` / `electron-fullscreen` so CSS can inset
 *   the topbar around the hiddenInset traffic lights and mark a drag region.
 * - Tags <html> with `vibrancy` (effective tier 'enhanced' only) to let the
 *   under-window material show through translucent backgrounds.
 * - Routes native menu / dock menu actions.
 * - Accepts a CSV dropped anywhere on the window (and Finder "open with")
 *   and hands it to the import page. Also stops Chromium's default
 *   navigate-to-dropped-file behavior inside the shell.
 */
export function ElectronBridge({ onOpenSettings, onOpenShortcuts }: ElectronBridgeProps) {
    const navigate = useNavigate();
    const { toggleSidebar } = useSidebar();
    const { tier: effectsTier } = useVisualEffectsTier();

    // The IPC subscriptions must attach exactly once (main flushes its queue
    // on the first ready() call), so dynamic handlers go through a ref.
    const handlersRef = useRef({ navigate, toggleSidebar, onOpenSettings, onOpenShortcuts });
    handlersRef.current = { navigate, toggleSidebar, onOpenSettings, onOpenShortcuts };

    useEffect(() => {
        const api = getElectronAPI();
        if (!api) return;

        if (isElectronMac()) {
            document.documentElement.classList.add('electron-mac');
        }

        const unsubFullScreen = api.onFullScreenChange((isFullScreen) => {
            document.documentElement.classList.toggle('electron-fullscreen', isFullScreen);
        });

        const unsubMenu = api.onMenuAction(({ action, payload }: ElectronMenuAction) => {
            const h = handlersRef.current;
            switch (action) {
                case 'navigate':
                    if (typeof payload === 'string' && payload.startsWith('/')) h.navigate(payload);
                    break;
                case 'open-settings':
                    h.onOpenSettings('general');
                    break;
                case 'open-shortcuts':
                    h.onOpenShortcuts();
                    break;
                case 'new-transaction':
                    h.navigate('/transactions?new=1');
                    break;
                case 'toggle-sidebar':
                    h.toggleSidebar();
                    break;
            }
        });

        const unsubCsv = api.onCsvOpen(({ name, content }) => {
            if (typeof name !== 'string' || typeof content !== 'string') return;
            const file = new File([content], name, { type: 'text/csv' });
            registerPendingImportFile(file);
            handlersRef.current.navigate('/import');
        });

        // Window-level CSV drop. Without this, dropping a file on the shell
        // navigates the webContents to the file URL (will-navigate allows
        // file: for the error page) — so swallow every file drop and route
        // CSVs to the import flow instead.
        const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
        const onDragOver = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };
        const onDrop = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            const handledByDropzone = e.target instanceof Element && e.target.closest('[data-dropzone]');
            e.preventDefault();
            if (handledByDropzone) return;
            const file = e.dataTransfer?.files?.[0];
            if (file && /\.csv$/i.test(file.name)) {
                registerPendingImportFile(file);
                handlersRef.current.navigate('/import');
            }
        };
        window.addEventListener('dragover', onDragOver);
        window.addEventListener('drop', onDrop);

        // Listeners are mounted — flush anything main queued (dock menu
        // clicks on a cold window, Finder open-file at launch).
        api.ready().catch(() => { /* best-effort */ });

        return () => {
            unsubFullScreen();
            unsubMenu();
            unsubCsv();
            window.removeEventListener('dragover', onDragOver);
            window.removeEventListener('drop', onDrop);
        };
    }, []);

    // Vibrancy is the one genuinely risky visual (translucent window over
    // opaque design tokens) — strictly behind the 'enhanced' tier. Using the
    // *effective* tier means auto-adapt also drops vibrancy on large displays,
    // where macOS would otherwise blur the desktop behind the whole window.
    useEffect(() => {
        const on = isElectronMac() && effectsTier === 'enhanced';
        document.documentElement.classList.toggle('vibrancy', on);
        return () => { document.documentElement.classList.remove('vibrancy'); };
    }, [effectsTier]);

    return null;
}
