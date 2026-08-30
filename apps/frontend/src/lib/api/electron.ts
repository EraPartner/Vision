import { apiRequest } from "@/lib/api/client";
import { saveSetting, getSetting } from "@/lib/api/settings";

type UpdateMode = "source" | "docker" | "native" | "dev";

type ElectronUpdater = {
    checkRelease?: () => Promise<{
        up_to_date: boolean;
        current_version: string;
        latest_version: string | null;
        published_at?: string;
        release_notes?: string;
        html_url?: string;
        update_mode?: UpdateMode;
        error?: string;
    }>;
    pullImage: () => Promise<{
        success: boolean;
        wasNew: boolean;
        error?: string;
    }>;
    installShellUpdate?: () => Promise<{
        success: boolean;
        version?: string;
        error?: string;
    }>;
    getMode?: () => Promise<{
        mode: UpdateMode;
        is_packaged: boolean;
        use_repo_mode: boolean;
    }>;
    preUpdateBackup?: () => Promise<{
        success: boolean;
        file?: string;
        error?: string;
    }>;
};

/** Snapshot of frontend localStorage keys collected before a backup. */
type FrontendStateSnapshot = { keys: Record<string, string> };

type ElectronBackup = {
    runBackup: (
        destDir: string,
        frontendStateJson?: string | null,
    ) => Promise<{
        success: boolean;
        file?: string;
        encrypted?: boolean;
        warning?: string;
        cleanupRemoved?: number;
        error?: string;
    }>;
    selectFile: () => Promise<string | null>;
    /** Accepts .visionbak, .visionbak.enc, or legacy .sql / .enc files. */
    restoreBackup: (
        filePath: string,
        opts?: { passphrase?: string },
    ) => Promise<{
        success: boolean;
        file?: string;
        frontendState?: FrontendStateSnapshot | null;
        error?: string;
    }>;
    /** Detect whether a backup file is encrypted (bundle or legacy). */
    isEncrypted?: (filePath: string) => Promise<boolean>;
    selectDir: () => Promise<string | null>;
    saveSettings: (settings: {
        backupDir: string;
        backupOnQuit: boolean;
    }) => Promise<void>;
    loadSettings: () => Promise<{ backupDir: string; backupOnQuit: boolean }>;
    getEncryptionStatus?: () => Promise<{
        success: boolean;
        secureStorageAvailable: boolean;
        hasStoredPassphrase: boolean;
        hasEnvPassphrase: boolean;
    }>;
    setPassphrase?: (
        passphrase: string,
    ) => Promise<{ success: boolean; available: boolean; error?: string }>;
};

type ElectronServices = {
    saveSettings: (settings: { keepServicesOnQuit: boolean }) => Promise<void>;
    loadSettings: () => Promise<{ keepServicesOnQuit: boolean }>;
};

/** Native menu / dock menu message — see packaging/electron/main.js menuAction(). */
export interface ElectronMenuAction {
    action:
        | "navigate"
        | "open-settings"
        | "open-shortcuts"
        | "new-transaction"
        | "toggle-sidebar";
    payload?: unknown;
}

/** CSV handed over by Finder/dock "open with Vision". */
export interface ElectronCsvFile {
    name: string;
    content: string;
}

type ElectronAPI = {
    platform: string;
    ready: () => Promise<{ success: boolean }>;
    setDockBadge: (count: number) => Promise<{ success: boolean }>;
    setLanguage?: (language: "en" | "nl") => Promise<{ success: boolean }>;
    getAccentColor: () => Promise<string | null>;
    onAccentColorChanged: (cb: (color: string | null) => void) => () => void;
    onMenuAction: (cb: (message: ElectronMenuAction) => void) => () => void;
    onCsvOpen: (cb: (file: ElectronCsvFile) => void) => () => void;
    onFullScreenChange: (cb: (isFullScreen: boolean) => void) => () => void;
    /** Persist the active theme's primary colors so the next boot splash matches. */
    persistSplashTheme?: (
        colors: SplashThemeColors,
    ) => Promise<{ success: boolean }>;
};

/** HSL component strings (e.g. "158 64% 52%") for the boot-splash background/text. */
export interface SplashThemeColors {
    background: string;
    foreground: string;
}

function getElectronUpdater(): ElectronUpdater | undefined {
    return (window as Window & { electronUpdater?: ElectronUpdater })
        .electronUpdater;
}

function getElectronBackup(): ElectronBackup | undefined {
    return (window as Window & { electronBackup?: ElectronBackup })
        .electronBackup;
}

function getElectronServices(): ElectronServices | undefined {
    return (window as Window & { electronServices?: ElectronServices })
        .electronServices;
}

export function getElectronAPI(): ElectronAPI | undefined {
    return (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
}

export function isElectron(): boolean {
    return !!getElectronUpdater();
}

/** True inside the Electron shell on macOS — gates traffic-light inset, dock features, accent. */
export function isElectronMac(): boolean {
    return getElectronAPI()?.platform === "darwin";
}

/** Set the native taskbar/dock badge (0 clears). No-op outside Electron. */
export function setDockBadge(count: number): void {
    getElectronAPI()
        ?.setDockBadge(count)
        .catch(() => {
            /* badge is best-effort */
        });
}

/** Keep Electron-native menus and dialogs aligned with the in-app language. */
export function setNativeLanguage(language: "en" | "nl"): void {
    getElectronAPI()
        ?.setLanguage?.(language)
        .catch(() => {
            /* best-effort */
        });
}

/**
 * Persist the resolved theme's primary colors so the Electron boot splash can
 * paint in the active palette next launch (emerald on default, purple on
 * dracula, …). Best-effort, no-op outside Electron — the splash falls back to a
 * neutral slate when nothing is persisted.
 */
export function persistSplashTheme(colors: SplashThemeColors): void {
    getElectronAPI()
        ?.persistSplashTheme?.(colors)
        .catch(() => {
            /* best-effort */
        });
}

/** macOS system accent color as RRGGBBAA hex, or null outside Electron/macOS. */
export async function getSystemAccentColor(): Promise<string | null> {
    const api = getElectronAPI();
    if (!api) return null;
    try {
        return await api.getAccentColor();
    } catch {
        return null;
    }
}

export async function checkForUpdates(): Promise<{
    up_to_date: boolean;
    current_version: string;
    latest_version: string | null;
    published_at?: string;
    release_notes?: string;
    html_url?: string;
    error?: string;
    /**
     * How this deployment installs updates. Electron supplies 'source' | 'docker'
     * | 'dev' over IPC; the HTTP route (reached only outside Electron) reports
     * 'docker-compose', which has no in-app installer — the user runs
     * `docker compose pull` themselves.
     */
    update_mode?: "source" | "docker" | "native" | "dev" | "docker-compose";
}> {
    const updater = getElectronUpdater();
    if (updater?.checkRelease) {
        return updater.checkRelease();
    }
    return apiRequest("/api/admin/update/check");
}

export async function triggerDockerUpdate(): Promise<{
    success: boolean;
    wasNew: boolean;
    error?: string;
} | null> {
    const updater = getElectronUpdater();
    if (!updater) return null;
    return updater.pullImage();
}

export async function installShellUpdate(): Promise<{
    success: boolean;
    version?: string;
    error?: string;
    /**
     * Set when the release carries no source-launcher asset to install from
     * (every release published before the pipeline started building one). The
     * main process has already opened `html_url` in the browser — the UI should
     * say so rather than report a failure.
     */
    manual_download?: boolean;
    html_url?: string;
} | null> {
    const updater = getElectronUpdater();
    if (!updater?.installShellUpdate) return null;
    return updater.installShellUpdate();
}

export async function preUpdateBackup(): Promise<{
    success: boolean;
    file?: string;
    error?: string;
} | null> {
    const updater = getElectronUpdater();
    if (!updater?.preUpdateBackup) return null;
    return updater.preUpdateBackup();
}

export async function runBackup(
    destDir: string,
    frontendStateJson: string | null = null,
): Promise<{
    success: boolean;
    file?: string;
    encrypted?: boolean;
    warning?: string;
    cleanupRemoved?: number;
    error?: string;
} | null> {
    const backup = getElectronBackup();
    if (!backup) return null;
    return backup.runBackup(destDir, frontendStateJson);
}

export async function selectBackupFile(): Promise<string | null> {
    const backup = getElectronBackup();
    if (!backup) return null;
    return backup.selectFile();
}

export async function restoreBackup(
    filePath: string,
    opts?: { passphrase?: string },
): Promise<{
    success: boolean;
    file?: string;
    frontendState?: FrontendStateSnapshot | null;
    error?: string;
} | null> {
    const backup = getElectronBackup();
    if (!backup) return null;
    return backup.restoreBackup(filePath, opts);
}

export async function isBackupEncrypted(filePath: string): Promise<boolean> {
    const backup = getElectronBackup();
    if (!backup?.isEncrypted) return false;
    try {
        return await backup.isEncrypted(filePath);
    } catch {
        return false;
    }
}

export async function selectBackupDir(): Promise<string | null> {
    const backup = getElectronBackup();
    if (!backup) return null;
    return backup.selectDir();
}

export async function saveBackupSettings(settings: {
    backupDir: string;
    backupOnQuit: boolean;
}): Promise<void> {
    await saveSetting("backup_settings", settings);
    const backup = getElectronBackup();
    if (backup) backup.saveSettings(settings).catch(() => {});
}

export async function loadBackupSettings(): Promise<{
    backupDir: string;
    backupOnQuit: boolean;
} | null> {
    const backup = getElectronBackup();
    if (backup) {
        try {
            return await backup.loadSettings();
        } catch {
            // fall through to backend API read
        }
    }
    try {
        const result = await getSetting("backup_settings");
        if (result?.value) {
            const v = result.value as {
                backupDir?: string;
                backupOnQuit?: boolean;
            };
            return {
                backupDir: v.backupDir ?? "",
                backupOnQuit: v.backupOnQuit ?? false,
            };
        }
    } catch {
        // fall through
    }
    return null;
}

/**
 * Persist the opt-in "keep services running on quit" toggle. No-op outside
 * Electron (there is nothing to keep running). Same dual-write as
 * saveBackupSettings: the database is the source of truth, the Electron
 * settings.json mirror is the fallback the will-quit handler reads when the
 * backend has already started shutting down.
 */
export async function saveServicesSettings(settings: {
    keepServicesOnQuit: boolean;
}): Promise<void> {
    await saveSetting("services_settings", settings);
    const services = getElectronServices();
    if (services) services.saveSettings(settings).catch(() => {});
}

export async function loadServicesSettings(): Promise<{
    keepServicesOnQuit: boolean;
} | null> {
    const services = getElectronServices();
    if (services) {
        try {
            return await services.loadSettings();
        } catch {
            // fall through to backend API read
        }
    }
    try {
        const result = await getSetting("services_settings");
        if (result?.value) {
            const v = result.value as { keepServicesOnQuit?: boolean };
            return { keepServicesOnQuit: v.keepServicesOnQuit ?? false };
        }
    } catch {
        // fall through
    }
    return null;
}

export async function getBackupEncryptionStatus(): Promise<{
    success: boolean;
    secureStorageAvailable: boolean;
    hasStoredPassphrase: boolean;
    hasEnvPassphrase: boolean;
} | null> {
    const backup = getElectronBackup();
    if (!backup?.getEncryptionStatus) return null;
    return backup.getEncryptionStatus();
}

export async function setBackupPassphrase(
    passphrase: string,
): Promise<{ success: boolean; available: boolean; error?: string } | null> {
    const backup = getElectronBackup();
    if (!backup?.setPassphrase) return null;
    return backup.setPassphrase(passphrase);
}
