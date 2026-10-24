import { describe, expect, it } from "vitest";

import { getToolSchemas } from "../src/services/aiChat/tools/index.ts";
import {
  selectToolSchemas,
  withCalledTools,
} from "../src/services/aiChat/toolSelection.ts";

const all = getToolSchemas();
const names = (schemas: typeof all) =>
  schemas.map((schema) => schema.function.name);

describe("selectToolSchemas", () => {
  it("sends the matching area and getCategories for a portfolio question", () => {
    const sent = names(
      selectToolSchemas({
        schemas: all,
        question: "How is my portfolio doing?",
      }),
    );
    expect(sent).toEqual(
      expect.arrayContaining([
        "getCategories",
        "getPortfolioHoldings",
        "getUnrealizedGains",
        "getBestWorstPerformers",
      ]),
    );
    expect(sent.length).toBeLessThan(all.length / 2);
  });

  it("sends every tool when the question matches none", () => {
    expect(
      selectToolSchemas({ schemas: all, question: "How am I doing?" }),
    ).toBe(all);
  });

  it("keeps tools used earlier and required pre-calls, in registry order", () => {
    const sent = names(
      selectToolSchemas({
        schemas: all,
        question: "Who do I pay the most?",
        usedTools: ["getWatchlist"],
        required: ["insightsDigest"],
      }),
    );
    expect(sent).toEqual(
      expect.arrayContaining(["getWatchlist", "insightsDigest"]),
    );
    expect(sent).toEqual(names(all).filter((name) => sent.includes(name)));
  });
});

describe("withCalledTools", () => {
  it("adds registered tools the model called without their schema", () => {
    const sent = all.filter(
      (schema) => schema.function.name === "getCategories",
    );
    expect(
      names(withCalledTools(sent, all, ["getBankBalances", "notATool"])),
    ).toEqual(
      names(all).filter((name) =>
        ["getCategories", "getBankBalances"].includes(name),
      ),
    );
    expect(withCalledTools(sent, all, ["getCategories"])).toBe(sent);
  });
});
