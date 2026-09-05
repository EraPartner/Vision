import { apiRequest } from "@/lib/api/client";
import { saveSetting, getSetting } from "@/lib/api/settings";
import type {
    BackupResult,
    ElectronApiBridge,
    InstallUpdateResult,
    PullImageResult,
    RestoreResult,
    SplashThemeColors,
    UpdateCheckStatus,
} from "@vision/types/electron";
export type {
    ElectronCsvFile,
    ElectronMenuAction,
    SplashThemeColors,
    UpdateCheckStatus,
} from "@vision/types/electron";

function getElectronUpdater() {
    return window.electronUpdater;
}

function getElectronBackup() {
    return window.electronBackup;
}

function getElectronServices() {
    return window.electronServices;
}

export function getElectronAPI(): ElectronApiBridge | undefined {
    return window.electronAPI;
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

/** Toggle the macOS under-window material. No-op outside a supporting shell. */
export function setNativeVibrancy(enabled: boolean): void {
    getElectronAPI()
        ?.setVibrancy?.(enabled)
        .catch(() => {
            /* best-effort visual optimization */
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

export async function checkForUpdates(): Promise<UpdateCheckStatus> {
    const updater = getElectronUpdater();
    if (updater?.checkRelease) {
        return updater.checkRelease();
    }
    return apiRequest("/api/admin/update/check");
}

export async function triggerDockerUpdate(): Promise<PullImageResult | null> {
    const updater = getElectronUpdater();
    if (!updater) return null;
    return updater.pullImage();
}

export async function installShellUpdate(): Promise<InstallUpdateResult | null> {
    const updater = getElectronUpdater();
    if (!updater?.installShellUpdate) return null;
    return updater.installShellUpdate();
}

export async function preUpdateBackup(): Promise<BackupResult | null> {
    const updater = getElectronUpdater();
    if (!updater?.preUpdateBackup) return null;
    return updater.preUpdateBackup();
}

export async function runBackup(
    destDir: string,
    frontendStateJson: string | null = null,
): Promise<BackupResult | null> {
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
): Promise<RestoreResult | null> {
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
