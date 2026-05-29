// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { BackupTab } from "@/components/settings/tabs/BackupTab";

// ── Electron preload mocks ───────────────────────────────────────────────────
// `apiClient.isElectron()` returns true iff `window.electronUpdater` exists,
// and the backup operations route through `window.electronBackup`. We install
// fresh stubs per test so each scenario can override behaviour.

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
        saveSettings: vi.fn().mockResolvedValue(undefined),
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
}

function clearElectronStubs() {
    const win = window as unknown as Record<string, unknown>;
    delete win.electronUpdater;
    delete win.electronBackup;
}

/**
 * Stateful wrapper so the controlled props (backupDir, backupOnQuit) can react
 * to the component's own setters during a flow.
 */
function BackupTabHarness({
    initialBackupDir = "",
    initialBackupOnQuit = false,
    open = true,
}: {
    initialBackupDir?: string;
    initialBackupOnQuit?: boolean;
    open?: boolean;
}) {
    const [backupDir, setBackupDir] = useState(initialBackupDir);
    const [backupOnQuit, setBackupOnQuit] = useState(initialBackupOnQuit);
    return (
        <BackupTab
            open={open}
            backupDir={backupDir}
            setBackupDir={setBackupDir}
            backupOnQuit={backupOnQuit}
            setBackupOnQuit={setBackupOnQuit}
        />
    );
}

beforeEach(() => {
    installElectronStubs();
});

afterEach(() => {
    clearElectronStubs();
    vi.restoreAllMocks();
});

describe("BackupTab", () => {
    it("renders Electron-only notice when not running in Electron", async () => {
        // Arrange — no electronUpdater means isElectron() returns false
        clearElectronStubs();

        // Act
        renderWithApp(<BackupTabHarness />);

        // Assert
        expect(
            await screen.findByText(/backup is only available in the desktop/i),
        ).toBeInTheDocument();
        // The "Backup Directory" label is only rendered in the Electron branch
        expect(screen.queryByText(/backup directory/i)).not.toBeInTheDocument();
    });

    it("renders backup directory + sections when Electron is available", async () => {
        // Arrange + Act
        installElectronStubs({}, { backupDir: "/Users/me/backups", backupOnQuit: false });
        renderWithApp(<BackupTabHarness initialBackupDir="/Users/me/backups" />);

        // Assert — main headings render
        expect(await screen.findByText(/backup directory/i)).toBeInTheDocument();
        expect(await screen.findByText(/restore from backup/i)).toBeInTheDocument();
        expect(await screen.findByText(/backup encryption/i)).toBeInTheDocument();
    });

    it("triggers backup when 'Back up now' is clicked with a configured directory", async () => {
        // Arrange
        const runBackup = vi
            .fn<() => Promise<BackupResult>>()
            .mockResolvedValue({ success: true, file: "/Users/me/backups/vision.visionbak" });
        installElectronStubs(
            { runBackup },
            { backupDir: "/Users/me/backups", backupOnQuit: false },
        );

        const user = userEvent.setup();
        renderWithApp(<BackupTabHarness initialBackupDir="/Users/me/backups" />);

        // The "Back up now" appears as both heading and button — find the button
        const backupButton = await screen.findByRole("button", { name: /back up now/i });
        await waitFor(() => expect(backupButton).not.toBeDisabled());

        // Act
        await user.click(backupButton);

        // Assert
        await waitFor(() => {
            expect(runBackup).toHaveBeenCalledTimes(1);
        });
    });

    it("backup button is disabled until a directory is configured", async () => {
        // Arrange + Act
        renderWithApp(<BackupTabHarness initialBackupDir="" />);

        // Assert
        const backupButton = await screen.findByRole("button", { name: /back up now/i });
        expect(backupButton).toBeDisabled();
    });

    it("Browse button updates the backup directory via setBackupDir", async () => {
        // Arrange
        const selectDir = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValue("/Users/me/picked");
        installElectronStubs({ selectDir });

        const user = userEvent.setup();
        renderWithApp(<BackupTabHarness initialBackupDir="" />);

        // Act — click the Browse button (visible because backupDir is empty)
        const browseButton = await screen.findByRole("button", { name: /browse/i });
        await user.click(browseButton);

        // Assert — selectDir was called and the input now reflects the new path
        await waitFor(() => {
            expect(selectDir).toHaveBeenCalledTimes(1);
        });
        await waitFor(() => {
            const input = screen.getByDisplayValue("/Users/me/picked");
            expect(input).toBeInTheDocument();
        });
    });

    it("opens the restore confirmation dialog when 'Restore now' is clicked with a selected file", async () => {
        // Arrange
        const selectFile = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValue("/Users/me/backups/snapshot.visionbak");
        installElectronStubs(
            { selectFile },
            { backupDir: "/Users/me/backups", backupOnQuit: false },
        );

        const user = userEvent.setup();
        renderWithApp(<BackupTabHarness initialBackupDir="/Users/me/backups" />);

        // Act — pick a backup file then click restore
        const chooseButton = await screen.findByRole("button", { name: /choose backup file/i });
        await user.click(chooseButton);

        await waitFor(() => {
            expect(selectFile).toHaveBeenCalledTimes(1);
        });

        const restoreButton = await screen.findByRole("button", { name: /^restore now$/i });
        await waitFor(() => expect(restoreButton).not.toBeDisabled());
        await user.click(restoreButton);

        // Assert — confirmation dialog is shown with destructive copy
        expect(
            await screen.findByRole("alertdialog", { name: /restore database\?/i }),
        ).toBeInTheDocument();
        // Confirm button uses 'Yes, restore' i18n string
        expect(
            await screen.findByRole("button", { name: /yes, restore/i }),
        ).toBeInTheDocument();
    });

    it("saves a passphrase via the encryption section when secure storage is available", async () => {
        // Arrange
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
        renderWithApp(<BackupTabHarness initialBackupDir="/Users/me/backups" />);

        // Wait for encryption status to resolve so passphrase input becomes enabled
        const passphraseInput = await screen.findByPlaceholderText(/enter passphrase/i);
        await waitFor(() => expect(passphraseInput).not.toBeDisabled());

        // Act — type a passphrase and click Save
        await user.type(passphraseInput, "supersecret");
        const saveButton = await screen.findByRole("button", { name: /save passphrase/i });
        await user.click(saveButton);

        // Assert
        await waitFor(() => {
            expect(setPassphrase).toHaveBeenCalledWith("supersecret");
        });
    });

    it("disables the backup-on-quit switch until a directory is configured", async () => {
        // Arrange + Act
        renderWithApp(<BackupTabHarness initialBackupDir="" />);

        // Assert — the switch is rendered but disabled when backupDir is empty
        const switchEl = await screen.findByRole("switch", { name: /back up when quitting/i });
        expect(switchEl).toBeDisabled();
    });

    it("toggles backup-on-quit when a directory is configured", async () => {
        // Arrange
        installElectronStubs({}, { backupDir: "/Users/me/backups", backupOnQuit: false });
        const user = userEvent.setup();
        renderWithApp(<BackupTabHarness initialBackupDir="/Users/me/backups" initialBackupOnQuit={false} />);

        // Act
        const switchEl = await screen.findByRole("switch", { name: /back up when quitting/i });
        await waitFor(() => expect(switchEl).not.toBeDisabled());
        await user.click(switchEl);

        // Assert — Radix Switch reflects the new checked state
        await waitFor(() => {
            expect(switchEl).toHaveAttribute("data-state", "checked");
        });
    });
});
