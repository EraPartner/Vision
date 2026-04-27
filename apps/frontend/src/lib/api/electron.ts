import { apiRequest } from '@/lib/api/client';
import { saveSetting, getSetting } from '@/lib/api/settings';

type ElectronUpdater = {
    checkRelease?: () => Promise<{
        up_to_date: boolean;
        current_version: string;
        latest_version: string | null;
        published_at?: string;
        release_notes?: string;
        html_url?: string;
        error?: string;
    }>;
    pullImage: () => Promise<{ success: boolean; wasNew: boolean; error?: string }>;
    installShellUpdate?: () => Promise<{ success: boolean; version?: string; error?: string }>;
};

/** Snapshot of frontend localStorage keys collected before a backup. */
type FrontendStateSnapshot = { keys: Record<string, string> };

type ElectronBackup = {
    runBackup: (destDir: string, frontendStateJson?: string | null) => Promise<{ success: boolean; file?: string; encrypted?: boolean; warning?: string; cleanupRemoved?: number; error?: string }>;
    selectFile: () => Promise<string | null>;
    /** Accepts .visionbak, .visionbak.enc, or legacy .sql / .enc files. */
    restoreBackup: (filePath: string, opts?: { passphrase?: string }) => Promise<{ success: boolean; file?: string; frontendState?: FrontendStateSnapshot | null; error?: string }>;
    /** Detect whether a backup file is encrypted (bundle or legacy). */
    isEncrypted?: (filePath: string) => Promise<boolean>;
    selectDir: () => Promise<string | null>;
    saveSettings: (settings: { backupDir: string; backupOnQuit: boolean }) => Promise<void>;
    loadSettings: () => Promise<{ backupDir: string; backupOnQuit: boolean }>;
    getEncryptionStatus?: () => Promise<{ success: boolean; secureStorageAvailable: boolean; hasStoredPassphrase: boolean; hasEnvPassphrase: boolean }>;
    setPassphrase?: (passphrase: string) => Promise<{ success: boolean; available: boolean; error?: string }>;
};

function getElectronUpdater(): ElectronUpdater | undefined {
    return (window as Window & { electronUpdater?: ElectronUpdater }).electronUpdater;
}

function getElectronBackup(): ElectronBackup | undefined {
    return (window as Window & { electronBackup?: ElectronBackup }).electronBackup;
}

export function isElectron(): boolean {
    return !!getElectronUpdater();
}

export async function checkForUpdates(): Promise<{
    up_to_date: boolean;
    current_version: string;
    latest_version: string | null;
    published_at?: string;
    release_notes?: string;
    html_url?: string;
    error?: string;
}> {
    const updater = getElectronUpdater();
    if (updater?.checkRelease) {
        return updater.checkRelease();
    }
    return apiRequest('/api/admin/update/check');
}

export async function triggerDockerUpdate(): Promise<{ success: boolean; wasNew: boolean; error?: string } | null> {
    const updater = getElectronUpdater();
    if (!updater) return null;
    return updater.pullImage();
}

export async function installShellUpdate(): Promise<{ success: boolean; version?: string; error?: string } | null> {
    const updater = getElectronUpdater();
    if (!updater?.installShellUpdate) return null;
    return updater.installShellUpdate();
}

export async function runBackup(
    destDir: string,
    frontendStateJson: string | null = null,
): Promise<{ success: boolean; file?: string; encrypted?: boolean; warning?: string; cleanupRemoved?: number; error?: string } | null> {
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
): Promise<{ success: boolean; file?: string; frontendState?: FrontendStateSnapshot | null; error?: string } | null> {
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
    await saveSetting('backup_settings', settings);
    const backup = getElectronBackup();
    if (backup) backup.saveSettings(settings).catch(() => {});
}

export async function loadBackupSettings(): Promise<{ backupDir: string; backupOnQuit: boolean } | null> {
    const backup = getElectronBackup();
    if (backup) {
        try {
            return await backup.loadSettings();
        } catch {
            // fall through to backend API read
        }
    }
    try {
        const result = await getSetting('backup_settings');
        if (result?.value) {
            const v = result.value as { backupDir?: string; backupOnQuit?: boolean };
            return { backupDir: v.backupDir ?? '', backupOnQuit: v.backupOnQuit ?? false };
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
