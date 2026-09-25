// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import { AgentCloakDesktopSettingsSection } from "../AgentCloakDesktopSettingsSection";

const ENDPOINT = "http://localhost:3002/api/ai-research/agentcloak-desktop";

describe("AgentCloak Desktop settings", () => {
    it("enables detected Desktop protection and updates the displayed status", async () => {
        let enabled = false;
        let submitted: unknown;
        server.use(
            http.get(ENDPOINT, () =>
                ok({
                    enabled,
                    available: true,
                    mappingKeyConfigured: enabled,
                    openAiEnabled: true,
                }),
            ),
            http.put(ENDPOINT, async ({ request }) => {
                submitted = await request.json();
                enabled = true;
                return ok({
                    enabled,
                    available: true,
                    mappingKeyConfigured: true,
                    openAiEnabled: true,
                });
            }),
        );

        renderWithApp(<AgentCloakDesktopSettingsSection />);
        expect(await screen.findByText("Desktop detected")).toBeInTheDocument();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Enable" }));

        await waitFor(() => {
            expect(submitted).toEqual({ enabled: true });
            expect(screen.getByText("Active")).toBeInTheDocument();
            expect(
                screen.getByRole("button", { name: "Disable" }),
            ).toBeEnabled();
        });
    });

    it("allows Desktop setup before OpenAI is configured", async () => {
        let enabled = false;
        let submitted: unknown;
        server.use(
            http.get(ENDPOINT, () =>
                ok({
                    enabled,
                    available: true,
                    mappingKeyConfigured: enabled,
                    openAiEnabled: false,
                }),
            ),
            http.put(ENDPOINT, async ({ request }) => {
                submitted = await request.json();
                enabled = true;
                return ok({
                    enabled,
                    available: true,
                    mappingKeyConfigured: true,
                    openAiEnabled: false,
                });
            }),
        );

        renderWithApp(<AgentCloakDesktopSettingsSection />);
        expect(await screen.findByText("Desktop detected")).toBeInTheDocument();
        expect(
            screen.getByText(
                "You can set up AgentCloak Desktop now. OpenAI investigations require separate OpenAI setup.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Enable" }));
        await waitFor(() => {
            expect(submitted).toEqual({ enabled: true });
            expect(screen.getByText("Active")).toBeInTheDocument();
        });
    });

    it("shows the backend error if setup fails", async () => {
        server.use(
            http.get(ENDPOINT, () =>
                ok({
                    enabled: false,
                    available: true,
                    mappingKeyConfigured: false,
                    openAiEnabled: true,
                }),
            ),
            http.put(ENDPOINT, () => err(503, "Desktop connection lost")),
        );

        renderWithApp(<AgentCloakDesktopSettingsSection />);
        await screen.findByText("Desktop detected");
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Enable" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Desktop connection lost",
        );
        expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
    });
});
