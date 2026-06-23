// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { BackupSection } from "@/components/settings/sections/BackupSection";

// ── Electron preload mocks ───────────────────────────────────────────────────
// `apiClient.isElectron()` returns true iff `window.electronUpdater` exists,
// and the backup operations route through `window.electronBackup`. BackupSection
// is self-contained: it loads the stored backup settings + encryption status on
// mount, so each scenario seeds them through the stubs below.

interface BackupSettings {
    backupDir: string;
    backupOnQuit: boolean;
}

interface EncryptionStatus {
    success: boolean;
    secureStorageAvailable: boolean;
    hasStoredPassphrase: boolean;
    hasEnvPassphrase: boolean;
}

interface BackupResult {
    success: boolean;
    file?: string;
    encrypted?: boolean;
    warning?: string;
    cleanupRemoved?: number;
    error?: string;
}

interface RestoreResult {
    success: boolean;
    file?: string;
    frontendState?: { keys: Record<string, string> } | null;
    error?: string;
}

interface BackupStubOverrides {
    loadSettings?: () => Promise<BackupSettings>;
    getEncryptionStatus?: () => Promise<EncryptionStatus>;
    selectDir?: () => Promise<string | null>;
    selectFile?: () => Promise<string | null>;
    runBackup?: () => Promise<BackupResult>;
    setPassphrase?: (passphrase: string) => Promise<{ success: boolean; available: boolean; error?: string }>;
    isEncrypted?: () => Promise<boolean>;
    restoreBackup?: () => Promise<RestoreResult>;
    saveSettings?: (s: BackupSettings) => Promise<void>;
}

function installElectronStubs(
    overrides: BackupStubOverrides = {},
    loadedSettings: BackupSettings = { backupDir: "", backupOnQuit: false },
) {
    const win = window as unknown as Record<string, unknown>;
    win.electronUpdater = {
        pullImage: vi.fn().mockResolvedValue({ success: true, wasNew: false }),
    };
    win.electronBackup = {
        runBackup:
            overrides.runBackup ??
            vi.fn().mockResolvedValue({ success: true, file: "/tmp/vision-2025-01-01.visionbak" }),
        selectFile: overrides.selectFile ?? vi.fn().mockResolvedValue(null),
        restoreBackup: overrides.restoreBackup ?? vi.fn().mockResolvedValue({ success: true, file: "x.visionbak" }),
        isEncrypted: overrides.isEncrypted ?? vi.fn().mockResolvedValue(false),
        selectDir: overrides.selectDir ?? vi.fn().mockResolvedValue(null),
        saveSettings: overrides.saveSettings ?? vi.fn().mockResolvedValue(undefined),
        loadSettings: overrides.loadSettings ?? vi.fn().mockResolvedValue(loadedSettings),
        getEncryptionStatus:
            overrides.getEncryptionStatus ??
            vi.fn().mockResolvedValue({
                success: true,
                secureStorageAvailable: true,
                hasStoredPassphrase: false,
                hasEnvPassphrase: false,
            }),
        setPassphrase:
            overrides.setPassphrase ??
            vi.fn().mockResolvedValue({ success: true, available: true }),
    };
    return win.electronBackup as Record<string, ReturnType<typeof vi.fn>>;
}

function clearElectronStubs() {
    const win = window as unknown as Record<string, unknown>;
    delete win.electronUpdater;
    delete win.electronBackup;
}

beforeEach(() => {
    installElectronStubs();
});

afterEach(() => {
    clearElectronStubs();
    vi.restoreAllMocks();
});

describe("BackupSection", () => {
    it("renders Electron-only notice when not running in Electron", async () => {
        clearElectronStubs();

        renderWithApp(<BackupSection />);

        expect(
            await screen.findByText(/backup is only available in the desktop/i),
        ).toBeInTheDocument();
        expect(screen.queryByText(/backup directory/i)).not.toBeInTheDocument();
    });

    it("renders backup directory + sections when Electron is available", async () => {
        installElectronStubs({}, { backupDir: "/Users/me/backups", backupOnQuit: false });
        renderWithApp(<BackupSection />);

        expect(await screen.findByText(/backup directory/i)).toBeInTheDocument();
        expect(await screen.findByText(/restore from backup/i)).toBeInTheDocument();
        expect(await screen.findByText(/backup encryption/i)).toBeInTheDocument();
    });

    it("triggers backup when 'Back up now' is clicked with a configured directory", async () => {
        const runBackup = vi
            .fn<() => Promise<BackupResult>>()
            .mockResolvedValue({ success: true, file: "/Users/me/backups/vision.visionbak" });
        installElectronStubs({ runBackup }, { backupDir: "/Users/me/backups", backupOnQuit: false });

        const user = userEvent.setup();
        renderWithApp(<BackupSection />);

        const backupButton = await screen.findByRole("button", { name: /back up now/i });
        await waitFor(() => expect(backupButton).not.toBeDisabled());

        await user.click(backupButton);

        await waitFor(() => {
            expect(runBackup).toHaveBeenCalledTimes(1);
        });
    });

    it("backup button is disabled until a directory is configured", async () => {
        renderWithApp(<BackupSection />);

        const backupButton = await screen.findByRole("button", { name: /back up now/i });
        expect(backupButton).toBeDisabled();
    });

    it("Browse button updates the backup directory and persists it", async () => {
        const selectDir = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValue("/Users/me/picked");
        const backup = installElectronStubs({ selectDir });

        const user = userEvent.setup();
        renderWithApp(<BackupSection />);

        const browseButton = await screen.findByRole("button", { name: /browse/i });
        await user.click(browseButton);

        await waitFor(() => expect(selectDir).toHaveBeenCalledTimes(1));
        await waitFor(() => {
            expect(screen.getByDisplayValue("/Users/me/picked")).toBeInTheDocument();
        });
        // Instant-apply: the new directory is persisted immediately.
        await waitFor(() => {
            expect(backup.saveSettings).toHaveBeenCalledWith({
                backupDir: "/Users/me/picked",
                backupOnQuit: false,
            });
        });
    });

    it("opens the restore confirmation dialog when 'Restore now' is clicked with a selected file", async () => {
        const selectFile = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValue("/Users/me/backups/snapshot.visionbak");
        installElectronStubs({ selectFile }, { backupDir: "/Users/me/backups", backupOnQuit: false });

        const user = userEvent.setup();
        renderWithApp(<BackupSection />);

        const chooseButton = await screen.findByRole("button", { name: /choose backup file/i });
        await user.click(chooseButton);

        await waitFor(() => expect(selectFile).toHaveBeenCalledTimes(1));

        const restoreButton = await screen.findByRole("button", { name: /^restore now$/i });
        await waitFor(() => expect(restoreButton).not.toBeDisabled());
        await user.click(restoreButton);

        expect(
            await screen.findByRole("alertdialog", { name: /restore database\?/i }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("button", { name: /yes, restore/i }),
        ).toBeInTheDocument();
    });

    it("saves a passphrase via the encryption section when secure storage is available", async () => {
        const setPassphrase = vi
            .fn<(passphrase: string) => Promise<{ success: boolean; available: boolean; error?: string }>>()
            .mockResolvedValue({ success: true, available: true });
        const getEncryptionStatus = vi
            .fn<() => Promise<EncryptionStatus>>()
            .mockResolvedValue({
                success: true,
                secureStorageAvailable: true,
                hasStoredPassphrase: false,
                hasEnvPassphrase: false,
            });
        installElectronStubs(
            { setPassphrase, getEncryptionStatus },
            { backupDir: "/Users/me/backups", backupOnQuit: false },
        );

        const user = userEvent.setup();
        renderWithApp(<BackupSection />);

        const passphraseInput = await screen.findByPlaceholderText(/enter passphrase/i);
        await waitFor(() => expect(passphraseInput).not.toBeDisabled());

        await user.type(passphraseInput, "supersecret");
        const saveButton = await screen.findByRole("button", { name: /save passphrase/i });
        await user.click(saveButton);

        await waitFor(() => {
            expect(setPassphrase).toHaveBeenCalledWith("supersecret");
        });
    });

    it("disables the backup-on-quit switch until a directory is configured", async () => {
        renderWithApp(<BackupSection />);

        const switchEl = await screen.findByRole("switch", { name: /back up when quitting/i });
        expect(switchEl).toBeDisabled();
    });

    it("toggles backup-on-quit when a directory is configured", async () => {
        installElectronStubs({}, { backupDir: "/Users/me/backups", backupOnQuit: false });
        const user = userEvent.setup();
        renderWithApp(<BackupSection />);

        const switchEl = await screen.findByRole("switch", { name: /back up when quitting/i });
        await waitFor(() => expect(switchEl).not.toBeDisabled());
        await user.click(switchEl);

        await waitFor(() => {
            expect(switchEl).toHaveAttribute("data-state", "checked");
        });
    });
});
