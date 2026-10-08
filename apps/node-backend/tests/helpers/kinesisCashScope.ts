import { fileURLToPath } from "node:url";
import { syntheticKinesisScope } from "./kinesisAdoptionScope.js";
const sourcePath = fileURLToPath(
  new URL("../fixtures/portfolio/kinesis-closed-cash.csv", import.meta.url),
);
export async function cashSource(options = {}) {
  const source = await syntheticKinesisScope({ sourcePath, ...options });
  return {
    ...source,
    cashContext: { ledger: [], sources: [], batches: [] },
    historicalFxContext: source.rows
      .filter((row) => row.route === "cash" && row.currency !== "EUR")
      .map((row) => ({
        currency: row.currency,
        date: row.tx_date,
        rate: "0.8",
      })),
  };
}
