// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { NetSummaryCard } from "@/features/dashboard/NetSummaryCard";
import { ok } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";

const API_BASE = "http://localhost:3002";

describe("NetSummaryCard income-versus-spending bar", () => {
  it("announces both full values and proportions as one image", () => {
    renderWithApp(
      <NetSummaryCard netBalance={250} income={1000} spending={750} history={[]} />,
    );

    const bar = screen.getByRole("img", { name: /Income:.*Spending:/i });
    const label = bar.getAttribute("aria-label") ?? "";

    expect(label).toMatch(/Income:.*1[.,]000.*57[.,]1\s*%/i);
    expect(label).toMatch(/Spending:.*750.*42[.,]9\s*%/i);
    expect(bar.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(bar.querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it("uses the active Dutch labels", async () => {
    server.use(
      http.get(`${API_BASE}/api/settings`, () =>
        ok({ app_settings: { language: "nl" } }),
      ),
    );

    renderWithApp(
      <NetSummaryCard netBalance={250} income={1000} spending={750} history={[]} />,
    );

    expect(
      await screen.findByRole("img", { name: /Inkomsten:.*Uitgaven:/i }),
    ).toHaveAccessibleName(/Inkomsten:.*57[.,]1\s*%.*Uitgaven:.*42[.,]9\s*%/i);
  });
});
