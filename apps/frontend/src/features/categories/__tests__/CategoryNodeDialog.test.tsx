// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { categoryNode } from "@/test/msw/rowFixtures";
import { CategoryNodeDialog } from "../CategoryNodeDialog";

it("explains a whitespace-only name and lets the retained form be corrected", async () => {
    let savedName = "";
    server.use(
        http.post(
            "http://localhost:3002/api/categories/tree",
            async ({ request }) => {
                const body = (await request.json()) as { name: string };
                savedName = body.name;
                return ok(categoryNode({ name: body.name }));
            },
        ),
    );
    const user = userEvent.setup();
    renderWithApp(<CategoryNodeDialog nodes={[]} open />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.type(name, "   ");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/required/i);
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(savedName).toBe("");
    await user.type(name, "Coffee  ");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    await waitFor(() => expect(savedName).toBe("Coffee"));
});
