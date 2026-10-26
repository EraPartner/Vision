/**
 * Real-PostgreSQL check that saving an exposure bundle upserts the supplied
 * sources and never deletes sources the bundle omits. Replaces a mocked-client
 * test that asserted the absence of DELETE in the emitted SQL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { upsertExposureBundle } from "../src/repositories/portfolioExposureRepository.ts";
import { must } from "./helpers/must.ts";
interface IdRow {
  id: number;
}

const SUFFIX = `PES${process.pid}`;
const investmentIds: number[] = [];

async function investment(): Promise<number> {
  const { rows } = await must(getTestPool(), "test pool").query<IdRow>(
    `INSERT INTO investments (name, asset_class, currency) VALUES ($1, 'stock', 'EUR') RETURNING id`,
    [`Exposure ${SUFFIX} ${investmentIds.length}`],
  );
  investmentIds.push(must(rows[0], "rows[0]").id);
  return must(rows[0], "rows[0]").id;
}

describe.skipIf(!hasTestDatabase())(
  "portfolio exposure sources (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const db = must(getTestPool(), "test pool");
      const ids = investmentIds.splice(0);
      await db.query(
        "DELETE FROM portfolio_exposure_classifications WHERE investment_id = ANY($1::int[])",
        [ids],
      );
      await db.query("DELETE FROM investments WHERE id = ANY($1::int[])", [
        ids,
      ]);
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("updates a supplied source in place and keeps sources the bundle omits", async () => {
      const first = await investment();
      const second = await investment();
      const classify = (investmentId: number, issuerName: string) => ({
        investmentId,
        issuerId: `issuer-${investmentId}`,
        issuerName,
        sourceLabel: "User mapping",
      });

      await upsertExposureBundle({
        classifications: [classify(first, "Issuer One")],
        fundDocuments: [],
      });
      const bundle = await upsertExposureBundle({
        classifications: [classify(second, "Issuer Two")],
        fundDocuments: [],
      });
      expect(
        bundle.classifications
          .filter((row) => [first, second].includes(must(row.investmentId, "row.investmentId")))
          .map((row) => row.investmentId)
          .sort((a, b) => must(a, "a") - must(b, "b")),
      ).toEqual([first, second].sort((a, b) => a - b));

      const updated = await upsertExposureBundle({
        classifications: [classify(first, "Issuer One Renamed")],
        fundDocuments: [],
      });
      const firstRows = updated.classifications.filter(
        (row) => row.investmentId === first,
      );
      expect(firstRows).toHaveLength(1);
      expect(firstRows[0]).toMatchObject({ issuerName: "Issuer One Renamed" });
    });
  },
);
