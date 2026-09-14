import { describe, expect, it } from "vitest";
import {
  analysisScenarioModelSchema,
  applyScenarioInputs,
  validateScenarioBindings,
} from "../src/services/analysisScenarioInputs.js";

const model = {
  attachments: [
    {
      id: "contract_options",
      fileName: "contract-options.csv",
      importedAt: "2026-09-14T10:00:00Z",
      sha256: "a".repeat(64),
      columns: [
        { id: "plan", label: "Plan", type: "string" },
        { id: "monthly_cost", label: "Monthly cost", type: "decimal" },
      ],
      rows: [
        { plan: "A", monthly_cost: "40.5" },
        { plan: "B", monthly_cost: "55" },
      ],
    },
  ],
  joins: [
    { inputId: "contract_options", resultColumn: "plan", inputColumn: "plan" },
  ],
};

describe("analysis scenario inputs", () => {
  it("left joins typed values without mutating source rows", () => {
    const rows = [
      { plan: "A", actual_cost: "38" },
      { plan: "C", actual_cost: "10" },
    ];
    expect(applyScenarioInputs(rows, model)).toEqual([
      { plan: "A", actual_cost: "38", "contract_options.monthly_cost": "40.5" },
      { plan: "C", actual_cost: "10", "contract_options.monthly_cost": null },
    ]);
    expect(rows[0]).toEqual({ plan: "A", actual_cost: "38" });
  });

  it("rejects duplicate join keys and undeclared cells", () => {
    const duplicate = structuredClone(model);
    duplicate.attachments[0].rows[1].plan = "A";
    expect(() => analysisScenarioModelSchema.parse(duplicate)).toThrow(
      /unique/,
    );
    const extra = structuredClone(model);
    extra.attachments[0].rows[0].ledgerWrite = true;
    expect(() => analysisScenarioModelSchema.parse(extra)).toThrow(
      /exactly match/,
    );
  });

  it("rejects values that do not match their declared column type", () => {
    const invalid = structuredClone(model);
    invalid.attachments[0].columns[1].type = "integer";
    invalid.attachments[0].rows[0].monthly_cost = "40.5";

    expect(() => analysisScenarioModelSchema.parse(invalid)).toThrow(
      /Scenario value must match integer/,
    );
  });

  it("rejects unsafe integer values", () => {
    const invalid = structuredClone(model);
    invalid.attachments[0].columns[1].type = "integer";
    invalid.attachments[0].rows[0].monthly_cost = 9007199254740992;
    invalid.attachments[0].rows[1].monthly_cost = 2;
    expect(() => analysisScenarioModelSchema.parse(invalid)).toThrow(
      /Scenario value must match integer/,
    );
  });

  it("fails closed when the result join column is absent or incompatible", () => {
    expect(() =>
      validateScenarioBindings(model, [{ id: "different", type: "string" }]),
    ).toThrow(/does not exist/);
    expect(() =>
      validateScenarioBindings(model, [{ id: "plan", type: "integer" }]),
    ).toThrow(/incompatible/);
    expect(() =>
      applyScenarioInputs([], model, [{ id: "different", type: "string" }]),
    ).toThrow(/does not exist/);
  });

  it("rejects multiple joins for one attachment", () => {
    const duplicate = structuredClone(model);
    duplicate.joins.push({
      inputId: "contract_options",
      resultColumn: "plan",
      inputColumn: "plan",
    });
    expect(() => analysisScenarioModelSchema.parse(duplicate)).toThrow(
      /only one join/,
    );
  });

  it("matches PostgreSQL integer strings to typed CSV integer keys", () => {
    const integerModel = structuredClone(model);
    integerModel.attachments[0].columns[0].type = "integer";
    integerModel.attachments[0].rows = [{ plan: 12, monthly_cost: "40.5" }];
    expect(
      applyScenarioInputs([{ plan: "12" }], integerModel, [
        { id: "plan", type: "integer" },
      ]),
    ).toEqual([{ plan: "12", "contract_options.monthly_cost": "40.5" }]);
  });

  it("never overwrites a result column during a join", () => {
    expect(() =>
      applyScenarioInputs(
        [{ plan: "A", "contract_options.monthly_cost": "private" }],
        model,
      ),
    ).toThrow(/must not replace/);
  });
});
