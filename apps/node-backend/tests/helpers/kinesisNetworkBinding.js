import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkSource } from "./kinesisNetwork.js";
import { syntheticKinesisScope } from "./kinesisAdoptionScope.js";

export async function networkBindingFixture({
  broker = 7,
  wallet = 8,
  investment = 1,
  witnessInvestment = null,
  batchId = 2,
  witnessBatchId = 3,
} = {}) {
  const witness = await networkSource({
      account: wallet,
      investment: witnessInvestment,
      batchId: witnessBatchId,
    }),
    dir = await mkdtemp(join(tmpdir(), "vision-native-binding-"));
  try {
    const file = join(dir, "broker.csv");
    await writeFile(
      file,
      "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Currency_Pair,Amount,Trade_Price,Total,Fee,Fee_Currency,Trade_Value,Trade_Value_Currency,Starting_Balance,Starting_Balance_Currency,Closing_Balance,Closing_Balance_Currency\n2026-01-02 10:00:00 UTC,SYNTHETIC-BROKER,KAG,Deposit," +
        "b".repeat(64) +
        ",,,0.03000,,0.03000,,,,,0,KAG,0.03000,KAG\n",
    );
    const primary = await syntheticKinesisScope({
      batchId,
      account: broker,
      investment,
      sourcePath: file,
    });
    for (const row of primary.rows) {
      row.resolved_investment_id = row.investment_id;
      row.user_override_investment_id = null;
    }
    for (const row of witness.rows) {
      row.resolved_investment_id = row.investment_id;
      row.user_override_investment_id = null;
    }
    return {
      rows: [...primary.rows, ...witness.rows],
      batches: [...primary.batches, ...witness.batches],
      history: [],
      witness,
      primary,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
