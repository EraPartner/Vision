import { describe, expect, it } from "vitest";
import { parseOpenAiModelCatalog } from "../src/config/openAiModelCatalog.js";

describe("OpenAI model catalog configuration", () => {
  it("parses an allowlisted catalog with per-model prices", () => {
    expect(
      parseOpenAiModelCatalog({
        catalogJson: JSON.stringify([
          {
            id: "model-small",
            label: "Small",
            inputMicrosPerMillion: 100,
            outputMicrosPerMillion: 200,
          },
          {
            id: "model-large",
            inputMicrosPerMillion: 300,
            outputMicrosPerMillion: 400,
          },
        ]),
        legacyModel: "model-small",
        legacyInputMicrosPerMillion: 0,
        legacyOutputMicrosPerMillion: 0,
      }),
    ).toEqual([
      {
        id: "model-small",
        label: "Small",
        inputMicrosPerMillion: 100,
        outputMicrosPerMillion: 200,
      },
      {
        id: "model-large",
        label: "model-large",
        inputMicrosPerMillion: 300,
        outputMicrosPerMillion: 400,
      },
    ]);
  });

  it("rejects duplicates and defaults outside the catalog", () => {
    const entry = {
      id: "model-small",
      inputMicrosPerMillion: 100,
      outputMicrosPerMillion: 200,
    };
    expect(() =>
      parseOpenAiModelCatalog({
        catalogJson: JSON.stringify([entry, entry]),
        legacyModel: "model-small",
        legacyInputMicrosPerMillion: 0,
        legacyOutputMicrosPerMillion: 0,
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseOpenAiModelCatalog({
        catalogJson: JSON.stringify([entry]),
        legacyModel: "model-large",
        legacyInputMicrosPerMillion: 0,
        legacyOutputMicrosPerMillion: 0,
      }),
    ).toThrow(/must name a model/);
  });

  it("keeps the single-model environment configuration backward compatible", () => {
    expect(
      parseOpenAiModelCatalog({
        catalogJson: undefined,
        legacyModel: "legacy-model",
        legacyInputMicrosPerMillion: 10,
        legacyOutputMicrosPerMillion: 20,
      }),
    ).toEqual([
      {
        id: "legacy-model",
        label: "legacy-model",
        inputMicrosPerMillion: 10,
        outputMicrosPerMillion: 20,
      },
    ]);
  });
});
