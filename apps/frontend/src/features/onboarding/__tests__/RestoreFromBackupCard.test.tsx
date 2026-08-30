// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { RestoreFromBackupCard } from "@/features/onboarding/RestoreFromBackupCard";

// Mock sonner toasts so we can assert without polluting the DOM.
vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
    },
}));

type ElectronBackupMock = {
    runBackup: ReturnType<typeof vi.fn>;
    selectFile: ReturnType<typeof vi.fn>;
    restoreBackup: ReturnType<typeof vi.fn>;
    isEncrypted: ReturnType<typeof vi.fn>;
    selectDir: ReturnType<typeof vi.fn>;
    saveSettings: ReturnType<typeof vi.fn>;
    loadSettings: ReturnType<typeof vi.fn>;
};

type ElectronUpdaterMock = {
    pullImage: ReturnType<typeof vi.fn>;
};

declare global {
    interface Window {
        electronUpdater?: ElectronUpdaterMock;
        electronBackup?: ElectronBackupMock;
    }
}

function installElectronMocks(overrides: Partial<ElectronBackupMock> = {}): {
    backup: ElectronBackupMock;
    updater: ElectronUpdaterMock;
} {
    const backup: ElectronBackupMock = {
        runBackup: vi.fn(),
        selectFile: vi.fn().mockResolvedValue(null),
        restoreBackup: vi.fn().mockResolvedValue({ success: true }),
        isEncrypted: vi.fn().mockResolvedValue(false),
        selectDir: vi.fn(),
        saveSettings: vi.fn(),
        loadSettings: vi.fn(),
        ...overrides,
    };
    const updater: ElectronUpdaterMock = {
        pullImage: vi.fn(),
    };
    window.electronBackup = backup;
    window.electronUpdater = updater;
    return { backup, updater };
}

function uninstallElectronMocks() {
    delete window.electronBackup;
    delete window.electronUpdater;
}

// Stub setTimeout for the page-reload schedule so tests do not actually reload.
const originalSetTimeout = window.setTimeout;

beforeEach(() => {
    // Prevent the post-success reload from scheduling during tests.
    vi.spyOn(window, "setTimeout").mockImplementation(((
        cb: (...args: unknown[]) => void,
        ms?: number,
    ) => {
        // Forward short timeouts (under 100ms) used by other libs (Radix, etc.)
        // but swallow the deliberate 3s reload timer.
        if (typeof ms === "number" && ms >= 1000) {
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(cb, ms);
    }) as typeof window.setTimeout);
});

afterEach(() => {
    uninstallElectronMocks();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("RestoreFromBackupCard", () => {
    it("renders nothing when not running in Electron", () => {
        // No electron globals installed → component should render null.
        const { container } = renderWithApp(<RestoreFromBackupCard />);
        expect(container).toBeEmptyDOMElement();
    });

    it("renders title, description, and restore button in Electron", async () => {
        installElectronMocks();
        renderWithApp(<RestoreFromBackupCard />);

        expect(
            await screen.findByText("Already have a Vision database?"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/If you have a Vision backup/i),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Restore from backup/i }),
        ).toBeInTheDocument();
    });

    it("does not open the confirm dialog when the user cancels the file picker", async () => {
        const { backup } = installElectronMocks({
            selectFile: vi.fn().mockResolvedValue(null),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );

        expect(backup.selectFile).toHaveBeenCalledTimes(1);
        // Confirm dialog title must not appear.
        expect(screen.queryByText("Restore database?")).not.toBeInTheDocument();
    });

    it("opens the confirm dialog with the selected file basename", async () => {
        installElectronMocks({
            selectFile: vi
                .fn()
                .mockResolvedValue("/tmp/backups/snapshot.visionbak"),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );

        expect(
            await screen.findByText("Restore database?"),
        ).toBeInTheDocument();
        expect(screen.getByText("snapshot.visionbak")).toBeInTheDocument();
    });

    it("closes the confirm dialog without restoring when user cancels", async () => {
        const { backup } = installElectronMocks({
            selectFile: vi.fn().mockResolvedValue("/tmp/snapshot.visionbak"),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );
        await screen.findByText("Restore database?");

        await user.click(screen.getByRole("button", { name: /^Cancel$/ }));

        await waitFor(() => {
            expect(
                screen.queryByText("Restore database?"),
            ).not.toBeInTheDocument();
        });
        expect(backup.restoreBackup).not.toHaveBeenCalled();
    });

    it("invokes restoreBackup with the selected file when user confirms", async () => {
        const { backup } = installElectronMocks({
            selectFile: vi.fn().mockResolvedValue("/tmp/snapshot.visionbak"),
            isEncrypted: vi.fn().mockResolvedValue(false),
            restoreBackup: vi.fn().mockResolvedValue({
                success: true,
                file: "snapshot.visionbak",
            }),
        });
        const onDismiss = vi.fn();
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard onDismiss={onDismiss} />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );
        await screen.findByText("Restore database?");
        await user.click(screen.getByRole("button", { name: /Yes, restore/i }));

        await waitFor(() => {
            expect(backup.restoreBackup).toHaveBeenCalledWith(
                "/tmp/snapshot.visionbak",
                undefined,
            );
        });
        await waitFor(() => {
            expect(onDismiss).toHaveBeenCalledTimes(1);
        });
    });

    it("restores the supported frontend localStorage snapshot", async () => {
        window.localStorage.clear();
        installElectronMocks({
            selectFile: vi.fn().mockResolvedValue("/tmp/snapshot.visionbak"),
            isEncrypted: vi.fn().mockResolvedValue(false),
            restoreBackup: vi.fn().mockResolvedValue({
                success: true,
                file: "snapshot.visionbak",
                frontendState: {
                    keys: {
                        vision_theme: "dark",
                        vision_theme_variant: "forest",
                    },
                },
            }),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );
        await screen.findByText("Restore database?");
        await user.click(screen.getByRole("button", { name: /Yes, restore/i }));

        await waitFor(() => {
            expect(window.localStorage.getItem("vision_theme")).toBe("dark");
            expect(window.localStorage.getItem("vision_theme_variant")).toBe(
                "forest",
            );
        });
    });

    it("surfaces a toast error when the restore fails", async () => {
        const { toast } = await import("sonner");
        installElectronMocks({
            selectFile: vi.fn().mockResolvedValue("/tmp/snapshot.visionbak"),
            isEncrypted: vi.fn().mockResolvedValue(false),
            restoreBackup: vi.fn().mockResolvedValue({
                success: false,
                error: "Disk write failure",
            }),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );
        await screen.findByText("Restore database?");
        await user.click(screen.getByRole("button", { name: /Yes, restore/i }));

        await waitFor(() => {
            expect(toast.error).toHaveBeenCalled();
        });
        const [, opts] = (toast.error as unknown as ReturnType<typeof vi.fn>)
            .mock.calls[0];
        expect(opts).toMatchObject({ description: "Disk write failure" });
    });

    it("opens the passphrase dialog when the chosen backup is encrypted", async () => {
        installElectronMocks({
            selectFile: vi.fn().mockResolvedValue("/tmp/secret.visionbak.enc"),
            isEncrypted: vi.fn().mockResolvedValue(true),
        });
        const user = userEvent.setup();
        renderWithApp(<RestoreFromBackupCard />);

        await user.click(
            await screen.findByRole("button", { name: /Restore from backup/i }),
        );
        await screen.findByText("Restore database?");
        await user.click(screen.getByRole("button", { name: /Yes, restore/i }));

        expect(
            await screen.findByText("Backup is encrypted"),
        ).toBeInTheDocument();
        expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
    });
});
