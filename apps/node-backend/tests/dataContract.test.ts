import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { logger } from "../src/config/logger.ts";
import {
  checkDataContract,
  dataContractMode,
  PRODUCTION_DATA_CONTRACT_MODE,
} from "../src/lib/dataContract.ts";

const schema = z.object({ rows: z.array(z.object({ amount: z.number() })) });

describe("dataContractMode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is strict in tests and development, the production constant elsewhere", () => {
    expect(dataContractMode("test")).toBe("throw");
    expect(dataContractMode("Development")).toBe("throw");
    expect(dataContractMode("production")).toBe(PRODUCTION_DATA_CONTRACT_MODE);
    expect(dataContractMode("staging")).toBe(PRODUCTION_DATA_CONTRACT_MODE);
    expect(PRODUCTION_DATA_CONTRACT_MODE).toBe("log");
  });

  it("treats any Vitest run as a test run, whatever NODE_ENV says", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(dataContractMode()).toBe("throw");
  });

  it("reads ENVIRONMENT before NODE_ENV, defaulting to development", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("NODE_ENV", "development");
    expect(dataContractMode()).toBe("log");
    vi.stubEnv("ENVIRONMENT", "");
    vi.stubEnv("NODE_ENV", "");
    expect(dataContractMode()).toBe("throw");
  });
});

describe("checkDataContract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true for matching data", () => {
    expect(checkDataContract(schema, { rows: [{ amount: 1 }] }, "probe")).toBe(
      true,
    );
  });

  it("throws in throw mode with issue paths and codes but no values", () => {
    expect(() =>
      checkDataContract(
        schema,
        { rows: [{ amount: "4242.42" }] },
        "probe",
        "throw",
      ),
    ).toThrow(
      new Error(
        "Data contract violated: probe at rows.0.amount (invalid_type)",
      ),
    );
  });

  it("caps the reported issues", () => {
    const rows = Array.from({ length: 12 }, () => ({ amount: NaN }));
    expect(() => checkDataContract(schema, { rows }, "probe", "throw")).toThrow(
      /rows\.9\.amount \(invalid_type\) \(\+2 more\)$/,
    );
  });

  it("logs paths only and reports a mismatch in log mode", () => {
    const value = { rows: [{ amount: "4242.42" }] };
    expect(checkDataContract(schema, value, "probe", "log")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "[data-contract] probe does not match its schema",
      { issues: ["rows.0.amount (invalid_type)"], issueCount: 1 },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "4242",
    );
  });
});
