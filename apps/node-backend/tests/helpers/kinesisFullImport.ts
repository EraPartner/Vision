import { fileURLToPath } from "node:url";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./kinesisAdoptionScope.js";
export async function fullFixture(options = {}) {
  const source = await syntheticKinesisScope({
    ...options,
    sourcePath: fileURLToPath(
      new URL(
        "../fixtures/portfolio/kinesis-full-paired-income.csv",
        import.meta.url,
      ),
    ),
  });
  const first = source.rows.find(
    (row) => row.source_transaction_id === "TX-OLDER:units",
  );
  const history = [
    {
      ...syntheticKinesisManual(first),
      units: "0.00100000",
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
      price_per_unit: null,
    },
  ];
  const historicalFxContext = source.rows
    .filter((row) => row.type === "dividend")
    .map((row) => ({ currency: row.currency, date: row.tx_date, rate: "0.8" }));
  return { ...source, history, historicalFxContext };
}
