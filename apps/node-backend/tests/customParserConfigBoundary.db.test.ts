/**
 * Real-PostgreSQL behaviour of saved custom CSV parser configs: name ordering
 * and partial updates. Replaces mocked-pool tests that asserted the SQL SET
 * clause and bound parameters.
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
import customParserConfigRepository from "../src/repositories/customParserConfigRepository.ts";
import { must } from "./helpers/must.ts";

const SUFFIX = `CPB${process.pid}`;
const ids: number[] = [];
const config = (amountColumn: string) => ({
  dateColumn: "Date",
  recipientColumn: "Name",
  amountColumn,
  memoColumn: "",
  dateFormat: "%Y-%m-%d",
  separator: ",",
  encoding: "utf-8",
  skipRows: 0,
});

async function create(name: string, amountColumn = "Amount") {
  const row = await customParserConfigRepository.create({
    name: `${name} ${SUFFIX}`,
    config: config(amountColumn),
  });
  ids.push(row.id);
  return row;
}

describe.skipIf(!hasTestDatabase())("custom parser configs (real DB)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM custom_parser_configs WHERE id = ANY($1::int[])",
      [ids.splice(0)],
    );
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("lists transaction configs ordered by name", async () => {
    const b = await create("B parser");
    const a = await create("A parser");
    const ours = (await customParserConfigRepository.getAll())
      .filter((row) => [a.id, b.id].includes(row.id))
      .map((row) => row.id);
    expect(ours).toEqual([a.id, b.id]);
  });

  it("updates only the supplied fields", async () => {
    const created = await create("Partial");

    const renamed = await customParserConfigRepository.update(created.id, {
      name: `Renamed ${SUFFIX}`,
    });
    expect(renamed).toMatchObject({
      name: `Renamed ${SUFFIX}`,
      config: config("Amount"),
    });

    const reconfigured = await customParserConfigRepository.update(created.id, {
      config: config("Bedrag"),
    });
    expect(reconfigured).toMatchObject({
      name: `Renamed ${SUFFIX}`,
      config: config("Bedrag"),
    });

    expect(
      await customParserConfigRepository.update(created.id, {}),
    ).toMatchObject({
      name: `Renamed ${SUFFIX}`,
      config: config("Bedrag"),
    });
  });
});
