/**
 * Real-database behaviour of saved custom CSV parser configs: name ordering
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
  beforeAll(acquireDbSuiteLock);

  afterEach(async () => {
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM custom_parser_configs WHERE id IN (SELECT value FROM json_each($1))",
      [JSON.stringify(ids.splice(0))],
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

  it("stores the config as canonical jsonb text and reads it back parsed", async () => {
    const created = await create("Canonical");
    const { rows } = await must(getTestPool(), "getTestPool()").query<{ config_json: string }>(
      "SELECT config_json FROM custom_parser_configs WHERE id = $1",
      [created.id],
    );
    // jsonb key order: shorter keys first, then bytewise; the read is parsed.
    expect(rows).toEqual([{ config_json: config("Amount") }]);
    const { rows: text } = await must(getTestPool(), "getTestPool()").query<{ t: string }>(
      "SELECT CAST(config_json AS TEXT) AS t FROM custom_parser_configs WHERE id = $1",
      [created.id],
    );
    expect(must(text[0], "text[0]").t).toBe(
      '{"encoding": "utf-8", "skipRows": 0, "separator": ",", "dateColumn": "Date", "dateFormat": "%Y-%m-%d", "memoColumn": "", "amountColumn": "Amount", "recipientColumn": "Name"}',
    );
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
