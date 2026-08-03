// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { useSettingsStore } from "@/stores/settingsStore";
import { RequireAdmin } from "../RequireAdmin";

function adminTree() {
    return (
        <Routes>
            <Route path="/" element={<div>home</div>} />
            <Route
                path="/admin"
                element={
                    <RequireAdmin>
                        <div>admin secret</div>
                    </RequireAdmin>
                }
            />
        </Routes>
    );
}

describe("RequireAdmin", () => {
    it("redirects to / when adminMode is off", async () => {
        useSettingsStore.setState({
            isAppSettingsLoading: false,
            appSettings: { ...useSettingsStore.getState().appSettings, adminMode: false },
        });

        renderWithApp(adminTree(), { initialEntries: ["/admin"] });

        expect(await screen.findByText("home")).toBeInTheDocument();
        expect(screen.queryByText("admin secret")).not.toBeInTheDocument();
    });

    it("renders children when adminMode is on", async () => {
        useSettingsStore.setState({
            isAppSettingsLoading: false,
            appSettings: { ...useSettingsStore.getState().appSettings, adminMode: true },
        });

        renderWithApp(adminTree(), { initialEntries: ["/admin"] });

        expect(await screen.findByText("admin secret")).toBeInTheDocument();
    });
});
