// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { EncodingSelect } from "../CsvFormatSelects";

it.each([
    ["latin1", "Latin-1"],
    ["latin-1", "Latin-1"],
    ["iso-8859-1", "ISO-8859-1"],
])("displays a matching encoding option for saved %s", (encoding, label) => {
    renderWithApp(
        <EncodingSelect id="encoding" value={encoding} onChange={vi.fn()} />,
    );
    expect(
        screen.getByRole("combobox", { name: /encoding/i }),
    ).toHaveTextContent(label);
});
