// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, AlertTitle } from "./alert";
import { Label } from "./label";

describe("wrapping text primitives", () => {
  it("gives alert titles and labels a positive line height", () => {
    render(
      <>
        <Alert>
          <AlertTitle>A long alert title that may wrap</AlertTitle>
        </Alert>
        <Label>A long field label that may wrap</Label>
      </>,
    );

    expect(screen.getByText("A long alert title that may wrap")).toHaveClass("leading-tight");
    expect(screen.getByText("A long field label that may wrap")).toHaveClass("leading-tight");
  });
});
