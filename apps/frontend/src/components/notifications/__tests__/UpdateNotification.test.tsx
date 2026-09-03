// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { UpdateNotification } from "@/components/notifications/UpdateNotification";

const API_BASE = "http://localhost:3002";

const UP_TO_DATE = {
    up_to_date: true,
    current_version: "1.2.3",
    latest_version: "1.2.3",
};

const UPDATE_AVAILABLE = {
    up_to_date: false,
    current_version: "1.2.3",
    latest_version: "1.3.0",
    published_at: "2025-04-01T00:00:00.000Z",
    release_notes: "- Bug fixes\n- New features",
    html_url: "https://example.com/release/1.3.0",
    update_mode: "source" as const,
};

/** Compatibility fixture for a legacy server that did not send update_mode. */
const { update_mode: _unusedMode, ...UPDATE_AVAILABLE_NO_MODE } =
    UPDATE_AVAILABLE;

afterEach(() => {
    vi.restoreAllMocks();
    // Clean up any electronUpdater stub that individual tests may have set.
    delete (window as unknown as { electronUpdater?: unknown }).electronUpdater;
});

describe("UpdateNotification", () => {
    it("renders nothing when app is up to date", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UP_TO_DATE),
            ),
        );

        const { container } = renderWithApp(<UpdateNotification />);

        // Give the effect time to fetch and decide nothing renders.
        await waitFor(() => {
            expect(container.querySelector("button")).toBeNull();
        });
    });

    it("renders update badge when a newer version is available", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE),
            ),
        );

        renderWithApp(<UpdateNotification />);

        expect(
            await screen.findByText(/update available/i),
        ).toBeInTheDocument();
    });

    it("opens dialog with version details on badge click", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);

        const badge = await screen.findByRole("button", {
            name: /update available/i,
        });
        await user.click(badge);

        const dialog = await screen.findByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(
            await screen.findByText(/version 1\.3\.0 is available/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/Bug fixes/)).toBeInTheDocument();
    });

    it("renders release notes link to the GitHub html_url", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );

        const link = await screen.findByRole("link", {
            name: /release notes/i,
        });
        expect(link).toHaveAttribute(
            "href",
            "https://example.com/release/1.3.0",
        );
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute(
            "rel",
            expect.stringContaining("noopener"),
        );
    });

    it("dismisses the dialog when 'Later' is clicked", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /later/i }));

        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    it("hides the Install button outside Electron and shows the compose command", async () => {
        // Browser (docker-compose self-host) deployments have no in-app
        // installer: installShellUpdate() is a no-op there, so the button used
        // to promise something it could not deliver.
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok({ ...UPDATE_AVAILABLE, update_mode: "docker-compose" }),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        const dialog = await screen.findByRole("dialog");

        expect(
            screen.queryByRole("button", { name: /install update/i }),
        ).not.toBeInTheDocument();
        expect(dialog).toHaveTextContent(
            /docker compose pull && docker compose up -d/i,
        );
        // The dismiss button is still there — the notice stays, only the dead
        // Install button goes away.
        expect(
            screen.getByRole("button", { name: /later/i }),
        ).toBeInTheDocument();
    });

    it("hides the Install button outside Electron even when update_mode is absent", async () => {
        // Legacy payloads can omit update_mode.
        // The gate must be isElectron(), not the mode default — the old code
        // defaulted to 'source' and rendered a dead button.
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE_NO_MODE),
            ),
        );
        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        await screen.findByRole("dialog");

        expect(
            screen.queryByRole("button", { name: /install update/i }),
        ).not.toBeInTheDocument();
    });

    it("closes the dialog without erroring when the release has no installable asset", async () => {
        // updater.js returns manual_download after opening the release page in
        // the browser. That is a redirect, not a failure — no error toast, and
        // the dialog must not stay stuck on the 'downloading' phase.
        const installShellUpdate = vi.fn().mockResolvedValue({
            success: false,
            manual_download: true,
            html_url:
                "https://github.com/EraPartner/Vision/releases/tag/v1.3.0",
            error: "This release has no in-app installer. Opening the download page in your browser.",
        });
        const preUpdateBackup = vi.fn().mockResolvedValue({ success: true });
        const checkRelease = vi.fn().mockResolvedValue(UPDATE_AVAILABLE);

        (window as unknown as { electronUpdater: unknown }).electronUpdater = {
            checkRelease,
            pullImage: vi.fn(),
            installShellUpdate,
            preUpdateBackup,
        };

        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        await screen.findByRole("dialog");

        await user.click(
            screen.getByRole("button", { name: /install update/i }),
        );

        await waitFor(() => {
            expect(installShellUpdate).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    it("calls Electron installShellUpdate when running inside Electron", async () => {
        // Stub the electronUpdater shim so apiClient.isElectron() returns true.
        const installShellUpdate = vi
            .fn()
            .mockResolvedValue({ success: true, version: "1.3.0" });
        const preUpdateBackup = vi.fn().mockResolvedValue({ success: true });
        const checkRelease = vi.fn().mockResolvedValue(UPDATE_AVAILABLE);

        (window as unknown as { electronUpdater: unknown }).electronUpdater = {
            checkRelease,
            pullImage: vi.fn(),
            installShellUpdate,
            preUpdateBackup,
        };

        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        await screen.findByRole("dialog");

        await user.click(
            screen.getByRole("button", { name: /install update/i }),
        );

        await waitFor(() => {
            expect(preUpdateBackup).toHaveBeenCalledTimes(1);
            expect(installShellUpdate).toHaveBeenCalledTimes(1);
        });
    });

    it("triggers Docker pull path when update_mode is 'docker'", async () => {
        const pullImage = vi
            .fn()
            .mockResolvedValue({ success: true, wasNew: true });
        const preUpdateBackup = vi.fn().mockResolvedValue({ success: true });
        const checkRelease = vi
            .fn()
            .mockResolvedValue({ ...UPDATE_AVAILABLE, update_mode: "docker" });

        (window as unknown as { electronUpdater: unknown }).electronUpdater = {
            checkRelease,
            pullImage,
            preUpdateBackup,
        };

        const user = userEvent.setup();

        renderWithApp(<UpdateNotification />);
        await user.click(
            await screen.findByRole("button", { name: /update available/i }),
        );
        await screen.findByRole("dialog");

        await user.click(
            screen.getByRole("button", { name: /install update/i }),
        );

        await waitFor(() => {
            expect(preUpdateBackup).toHaveBeenCalledTimes(1);
            expect(pullImage).toHaveBeenCalledTimes(1);
        });
    });
});
