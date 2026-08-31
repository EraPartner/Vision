/**
 * Validation-behavior pins for importRoutes.js (ZOD-07).
 *
 * Pins the exact accept/reject/coercion behavior of the request parsing: the
 * Number()-coerced batch-id guard (copy-pasted per route), the multipart CSV
 * option coercion (parseCsvImportOptions), the csv/custom required/trim/default
 * build, and normalizeParserConfig's defaults — so a change cannot alter the wire.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js), which
 * also puts the router's own trailing error middleware
 * (`router.use(csvUploadErrorTranslator)`, routes/importRoutes.js:580) on the
 * tested path — the mock-router harness dropped it entirely.
 *
 * multer is still stubbed to a pass-through (no real multipart parsing); the
 * uploaded file is injected by a `before` middleware, which is the same slot
 * `main.js` uses for per-mount middleware.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent } from "../helpers/routeApp.js";

vi.mock("multer", () => {
  const multer = vi.fn(() => ({
    single: vi.fn(() => (req, res, next) => next()),
  }));
  multer.MulterError = class MulterError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  };
  return { default: multer };
});

vi.mock("fs", () => {
  const unlink = vi.fn().mockResolvedValue(undefined);
  return {
    default: {
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
      promises: { unlink },
    },
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    promises: { unlink },
  };
});

vi.mock("os", () => ({
  default: { tmpdir: vi.fn(() => "/tmp") },
  tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("../../src/services/importPipeline/index.js", () => ({
  runImportPipeline: vi.fn(),
  commitImport: vi.fn(),
}));

vi.mock("../../src/services/dataImportService.js", () => ({
  importRecipientsCSV: vi.fn(),
  importCategoriesCSV: vi.fn(),
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../../src/repositories/importBatchRepository.js", () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  rollbackBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  overrideRecipient: vi.fn(),
  overrideCategory: vi.fn(),
  categoryExists: vi.fn(),
}));

vi.mock("../../src/services/aggregationRefresh.js", () => ({
  clearForecastMcCaches: vi.fn().mockResolvedValue(undefined),
  scheduleMaterializedViewRefresh: vi.fn(),
}));

vi.mock("../../src/repositories/customParserConfigRepository.js", () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/database/connection.js", () => mockConnection());

import {
  runImportPipeline,
  commitImport,
} from "../../src/services/importPipeline/index.js";
// NOT mocked: only .../importPipeline/index.js is. This is the real boundary
// function, run here over the mocked pg connection.
import { createBatch } from "../../src/services/importPipeline/stage.js";
import { importRecipientsCSV } from "../../src/services/dataImportService.js";
import {
  getBatch,
  getPreviewRows,
  overrideRecipient,
  overrideCategory,
  categoryExists,
} from "../../src/repositories/importBatchRepository.js";
import { query as dbQuery } from "../../src/database/connection.js";
import customParserConfigRepository from "../../src/repositories/customParserConfigRepository.js";

const { default: importRouter } =
  await import("../../src/routes/importRoutes.js");

const UPLOAD = { path: "/tmp/pin.csv", originalname: "pin.csv", size: 10 };

const BASE = "/api/import";
// multer is stubbed, so nothing populates req.file — inject it in the same
// per-mount slot main.js uses (main.js:325 mounts importRateLimiter there).
const api = routeAgent(importRouter, {
  mountPath: BASE,
  before: [
    (req, _res, next) => {
      req.file = { ...UPLOAD };
      next();
    },
  ],
});

/** Encode a path segment so ids with spaces survive the URL round-trip. */
const seg = (v) => encodeURIComponent(String(v));

describe("multipart parameter precedence", () => {
  it("uses a body bank_name before the legacy query fallback", async () => {
    runImportPipeline.mockResolvedValue({
      batchId: 1,
      total: 1,
      imported: 1,
      duplicates: 0,
      errors: 0,
    });

    await api
      .post(`${BASE}/csv`)
      .query({ bank_name: "query-bank" })
      .send({ bank_name: "body-bank" })
      .expect(201);

    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ adapterName: "body-bank" }),
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  runImportPipeline.mockResolvedValue({
    total: 1,
    imported: 1,
    duplicates: 0,
    errors: 0,
  });
  importRecipientsCSV.mockResolvedValue({ imported: 1, errors: 0 });
  customParserConfigRepository.create.mockResolvedValue({ id: 1 });
});

describe("batch-id shape pins (validateId, bounded to MAX_SAFE_ID)", () => {
  // This block used to pin the raw `Number()` coercion these routes ran on:
  // '12.0' → 12, ' 12 ' → 12, '0x10' → **16**. That was a behaviour-preserving
  // pin written during the zod swap (see the describe title it carried,
  // "Number() then integer > 0"), recording what Number() happened to do
  // rather than a contract worth keeping — and the '0x10' case is the same
  // wrong-record class the :id params lost in 060ef194: the client named no
  // batch 16, yet batch 16 is what it got. coercedIdSchema now delegates to
  // validateId, so only a plain digit string parses.
  it("rejects '12.0', ' 12 ' and '0x10' instead of coercing them to a batch", async () => {
    getBatch.mockResolvedValue({ id: 12, status: "complete" });

    for (const id of ["12.0", " 12 ", "0x10", "0o17", "0b11", "1e3", "+12"]) {
      const res = await api.get(`${BASE}/batches/${seg(id)}`).expect(400);
      expect(
        res.body.error.code,
        `expected ${JSON.stringify(id)} to be rejected`,
      ).toBe("VALIDATION_ERROR");
    }
    expect(getBatch).not.toHaveBeenCalled();

    await api.get(`${BASE}/batches/12`).expect(200);
    expect(getBatch).toHaveBeenLastCalledWith(12);
  });

  // The bound is MAX_SAFE_ID, not validateId's default int32 ceiling:
  // import_batches.id is BIGSERIAL (0001_initial_database_schema.py), so
  // capping at 2^31-1 would reject ids the column can legitimately hold. Above
  // 2^53 the digit string and the parsed number stop being the same value, so
  // that is where it has to stop — '9007199254740993' would otherwise address
  // record …992.
  it("accepts an integral id past int32 and 404s it, but rejects one past 2^53", async () => {
    getBatch.mockResolvedValue(undefined);

    const res = await api.get(`${BASE}/batches/2147483648`).expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(getBatch).toHaveBeenCalledWith(2147483648);

    getBatch.mockClear();
    for (const id of ["9007199254740993", "99999999999999999999"]) {
      const tooBig = await api.get(`${BASE}/batches/${id}`).expect(400);
      expect(tooBig.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(getBatch).not.toHaveBeenCalled();
  });

  // '1e300' used to be let through to a downstream 404 on purpose, to keep the
  // pre-zod wire unchanged (the old lib/importBatchIds.js header said so). That
  // reasoning was about not moving 404→400 during a mechanical swap, not about
  // 404 being the right answer: '1e300' names no batch in any notation this
  // API accepts, and it is the same exponent form that made '1e3' resolve to
  // batch 1000. It is now a 400 like every other malformed id.
  it("400s an exponent-notation id rather than 404ing it downstream", async () => {
    getBatch.mockResolvedValue(undefined);

    const res = await api.get(`${BASE}/batches/1e300`).expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(getBatch).not.toHaveBeenCalled();
  });

  it("rejects fractional, trailing-garbage, zero, and negative ids on every site", async () => {
    const badIds = ["12.5", "12abc", "0", "-1", "abc"];
    const sites = [
      (id) => api.get(`${BASE}/batches/${seg(id)}`),
      (id) => api.delete(`${BASE}/batches/${seg(id)}`),
      (id) => api.get(`${BASE}/batches/${seg(id)}/preview`),
      (id) => api.post(`${BASE}/batches/${seg(id)}/commit`).send({}),
    ];
    for (const site of sites) {
      for (const id of badIds) {
        const res = await site(id).expect(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    }
    expect(getBatch).not.toHaveBeenCalled();
  });

  it("row-override sites validate both ids and coerce them", async () => {
    overrideRecipient.mockResolvedValue(1);

    // Was ' 6 ' → rowId 6 (whitespace padding survived Number()); the padded
    // form is rejected now, so the happy path uses the plain digit string.
    await api
      .post(`${BASE}/batches/5/rows/6/override`)
      .send({ recipient_id: null })
      .expect(200);
    expect(overrideRecipient).toHaveBeenCalledWith({
      batchId: 5,
      rowId: 6,
      recipientId: null,
    });

    for (const { id, rowId } of [
      { id: "5", rowId: "0" },
      { id: "abc", rowId: "6" },
      { id: "5.5", rowId: "6" },
      { id: "5", rowId: " 6 " },
      { id: "5.0", rowId: "6" },
      { id: "0x10", rowId: "6" },
    ]) {
      await api
        .post(`${BASE}/batches/${seg(id)}/rows/${seg(rowId)}/override`)
        .send({})
        .expect(400);
      await api
        .post(`${BASE}/batches/${seg(id)}/rows/${seg(rowId)}/category-override`)
        .send({})
        .expect(400);
    }
  });
});

/**
 * Override-body id shape (`recipient_id`, `category_id`).
 *
 * The route ids above were converged first; these two lagged behind on
 * `Number.isInteger(Number(x))`, which rejects '12abc' but reads '1e3' as 1000,
 * '0x10' as 16, `true` as 1 and `[7]` as 7. That is not a failed validation, it
 * is a retarget — and this is the review step of an import, so the staging row
 * committed a transaction attributed to a recipient or category the user never
 * picked. Zero and negatives were accepted too and reached Postgres as an FK
 * violation.
 */
describe("override-body id shape (parseOverrideId)", () => {
  const RETARGETING = [
    "1e3",
    "0x10",
    "0o17",
    "0b11",
    true,
    [7],
    "+7",
    " 7 ",
    "7.0",
  ];
  const MALFORMED = [
    "12abc",
    "abc",
    "1.5",
    "0",
    "-1",
    "",
    {},
    "9007199254740993",
  ];

  it("rejects every value that used to resolve to a different recipient", async () => {
    for (const recipient_id of [...RETARGETING, ...MALFORMED]) {
      const res = await api
        .post(`${BASE}/batches/5/rows/6/override`)
        .send({ recipient_id })
        .expect(400);
      expect(
        res.body.error.code,
        `expected ${JSON.stringify(recipient_id)} to be rejected`,
      ).toBe("VALIDATION_ERROR");
    }
    expect(overrideRecipient).not.toHaveBeenCalled();
  });

  it("rejects every value that used to resolve to a different category, before the existence check", async () => {
    for (const category_id of [...RETARGETING, ...MALFORMED]) {
      const res = await api
        .post(`${BASE}/batches/5/rows/6/category-override`)
        .send({ category_id })
        .expect(400);
      expect(
        res.body.error.code,
        `expected ${JSON.stringify(category_id)} to be rejected`,
      ).toBe("VALIDATION_ERROR");
    }
    // The "does this category exist?" guard never saw a coerced id: '0x10'
    // named category 16, which exists, so the guard passed and the write went
    // through.
    expect(categoryExists).not.toHaveBeenCalled();
    expect(overrideCategory).not.toHaveBeenCalled();
  });

  it("still accepts a digit string or an integer, and clears on null or an absent field", async () => {
    overrideRecipient.mockResolvedValue(1);
    overrideCategory.mockResolvedValue(1);
    categoryExists.mockResolvedValue(true);

    for (const recipient_id of [7, "7", "007"]) {
      await api
        .post(`${BASE}/batches/5/rows/6/override`)
        .send({ recipient_id })
        .expect(200);
      expect(overrideRecipient).toHaveBeenLastCalledWith({
        batchId: 5,
        rowId: 6,
        recipientId: 7,
      });
    }

    // Absent and explicit null both mean "clear the override", at 200 — the
    // shipped clear-the-selection flow, unchanged.
    for (const body of [{}, { recipient_id: null }]) {
      const res = await api
        .post(`${BASE}/batches/5/rows/6/override`)
        .send(body)
        .expect(200);
      expect(overrideRecipient).toHaveBeenLastCalledWith({
        batchId: 5,
        rowId: 6,
        recipientId: null,
      });
      expect(res.body.data.user_override_recipient_id).toBeNull();
    }

    await api
      .post(`${BASE}/batches/5/rows/6/category-override`)
      .send({ category_id: "12" })
      .expect(200);
    expect(categoryExists).toHaveBeenLastCalledWith(12);
    expect(overrideCategory).toHaveBeenLastCalledWith({
      batchId: 5,
      rowId: 6,
      categoryId: 12,
    });

    for (const body of [{}, { category_id: null }]) {
      await api
        .post(`${BASE}/batches/5/rows/6/category-override`)
        .send(body)
        .expect(200);
      expect(overrideCategory).toHaveBeenLastCalledWith({
        batchId: 5,
        rowId: 6,
        categoryId: null,
      });
    }
  });
});

describe("parseCsvImportOptions pins (POST /recipients)", () => {
  const run = (query, body = {}) =>
    api.post(`${BASE}/recipients`).query(query).send(body);

  it('defaults separator to "," and encoding to "utf-8"', async () => {
    await run({}).expect(201);
    expect(importRecipientsCSV).toHaveBeenCalledWith("/tmp/pin.csv", {
      separator: ",",
      encoding: "utf-8",
    });
  });

  it("query wins over body; body is the fallback", async () => {
    await run({ separator: ";" }, { separator: "|" }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith("/tmp/pin.csv", {
      separator: ";",
      encoding: "utf-8",
    });

    await run({}, { separator: "|", encoding: "latin1" }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith("/tmp/pin.csv", {
      separator: "|",
      encoding: "latin1",
    });
  });

  it("stringifies a numeric separator (multipart/JSON tolerance)", async () => {
    await run({}, { separator: 5 }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith("/tmp/pin.csv", {
      separator: "5",
      encoding: "utf-8",
    });
  });

  it("empty-string separator falls back to the default", async () => {
    await run({ separator: "" }).expect(201);
    expect(importRecipientsCSV).toHaveBeenLastCalledWith("/tmp/pin.csv", {
      separator: ",",
      encoding: "utf-8",
    });
  });

  it("rejects a multi-character separator", async () => {
    const res = await run({ separator: ";;" }).expect(400);
    expect(res.body.error.message).toMatch(/separator/);
    expect(importRecipientsCSV).not.toHaveBeenCalled();
  });
});

describe("POST /csv/custom config-build pins", () => {
  const run = (query, body = {}) =>
    api.post(`${BASE}/csv/custom`).query(query).send(body);

  const requiredQuery = {
    bank_name: "Custom",
    date_format: "%d/%m/%Y",
    date_column: "Date",
    recipient_column: "Desc",
    amount_column: "Amount",
  };

  it("trims mapped columns but forwards the RAW bank_name as adapterName", async () => {
    await run({
      bank_name: " My Bank ",
      date_format: " %d/%m/%Y ",
      date_column: " Date ",
      recipient_column: " Desc ",
      amount_column: " Amt ",
      memo_column: " Memo ",
      separator: ";",
      encoding: "latin1",
      skip_rows: "2.9",
    }).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterName: " My Bank ",
        customConfig: {
          bank_name: "My Bank",
          date_format: "%d/%m/%Y",
          encoding: "latin1",
          separator: ";",
          skip_rows: 2,
          column_mapping: {
            date: "Date",
            recipient: "Desc",
            amount: "Amt",
            memo: "Memo",
          },
        },
      }),
    );
  });

  it('applies defaults: memo "", separator ",", encoding utf-8, skip_rows 0', async () => {
    await run(requiredQuery).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          encoding: "utf-8",
          separator: ",",
          skip_rows: 0,
          column_mapping: expect.objectContaining({ memo: "" }),
        }),
      }),
    );
  });

  it("coerces unparseable skip_rows to 0 and accepts an empty separator as default", async () => {
    await run({ ...requiredQuery, skip_rows: "abc", separator: "" }).expect(
      201,
    );
    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({ skip_rows: 0, separator: "," }),
      }),
    );
  });

  it("body fields override query fields", async () => {
    await run(requiredQuery, { amount_column: "BodyAmt" }).expect(201);
    expect(runImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          column_mapping: expect.objectContaining({ amount: "BodyAmt" }),
        }),
      }),
    );
  });
});

describe("normalizeParserConfig pins (POST /parsers)", () => {
  const create = (config) =>
    api.post(`${BASE}/parsers`).send({ name: "P", config });

  const base = {
    dateColumn: "Date",
    recipientColumn: "Name",
    amountColumn: "Amount",
  };

  it("coerces skipRows: numeric strings parse, floats floor, negatives become 0", async () => {
    for (const [input, expected] of [
      ["3", 3],
      [-5, 0],
      ["2.9", 2],
      ["abc", 0],
    ]) {
      await create({ ...base, skipRows: input }).expect(201);
      expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ skipRows: expected }),
        }),
      );
    }
  });

  it("does NOT enforce a single-char separator here — any non-empty string sticks", async () => {
    await create({ ...base, separator: ";;" }).expect(201);
    expect(customParserConfigRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ separator: ";;" }),
      }),
    );
  });

  it("strips unknown keys and blanks a non-string memoColumn", async () => {
    await create({ ...base, foo: "bar", memoColumn: 123 }).expect(201);
    const { config } = customParserConfigRepository.create.mock.calls.at(-1)[0];
    expect("foo" in config).toBe(false);
    expect(config.memoColumn).toBe("");
    expect(Object.keys(config).sort()).toEqual([
      "amountColumn",
      "dateColumn",
      "dateFormat",
      "encoding",
      "memoColumn",
      "recipientColumn",
      "separator",
      "skipRows",
    ]);
  });

  it("rejects missing required columns with the per-key message", async () => {
    const res1 = await create({ dateColumn: "Date", amountColumn: "A" }).expect(
      400,
    );
    expect(res1.body.error.message).toContain(
      "config.recipientColumn is required",
    );

    const res2 = await create({ ...base, dateColumn: "  " }).expect(400);
    expect(res2.body.error.message).toContain("config.dateColumn is required");
  });

  it("rejects a non-object or array config", async () => {
    for (const config of [null, "str", [1]]) {
      const res = await create(config).expect(400);
      expect(res.body.error.message).toContain('Missing or invalid "config"');
    }
  });
});

/**
 * `batch_id` wire type.
 *
 * The immediate-import responses (`POST /csv`, 201 and the 202 review variant)
 * relay `pipelineResult.batchId` straight from `createBatch`, while the
 * review-commit route re-reads the id off the URL through `coercedIdSchema`.
 * Those two producers disagreed until `createBatch` was normalized
 * (services/importPipeline/stage.js — pinned by tests/importPipeline.stage.test.js),
 * so `batch_id` was a string on one response and a number on the other and a
 * client doing `a.batch_id === b.batch_id` across them always saw false.
 * NUMBER is the single wire type; these pin every response that carries the field.
 */
describe("batch_id wire type", () => {
  const BATCH_ID = 12;

  // The pipeline is mocked here, but its `batchId` is produced by the REAL
  // `createBatch` running over the mocked pg connection primed with what
  // node-postgres actually returns for a BIGSERIAL: the STRING '12'. That keeps
  // these route pins honest — before the stage-boundary fix they failed with
  // `batch_id: "12"`, exactly the wire split the finding describes.
  const realBatchId = async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: String(BATCH_ID) }] });
    return createBatch({ adapterName: "vision" });
  };

  it("POST /csv (201, committed) emits a numeric batch_id", async () => {
    runImportPipeline.mockImplementation(async () => ({
      batchId: await realBatchId(),
      total: 1,
      imported: 1,
      duplicates: 0,
      errors: 0,
    }));

    const res = await api
      .post(`${BASE}/csv`)
      .query({ bank_name: "vision" })
      .expect(201);

    expect(typeof res.body.data.batch_id).toBe("number");
    expect(res.body.data.batch_id).toBe(BATCH_ID);
  });

  it("POST /csv (202, review required) emits a numeric batch_id", async () => {
    runImportPipeline.mockImplementation(async () => ({
      batchId: await realBatchId(),
      requiresReview: true,
      matchSourceCounts: { exact: 1 },
    }));

    const res = await api
      .post(`${BASE}/csv`)
      .query({ bank_name: "vision" })
      .expect(202);

    expect(typeof res.body.data.batch_id).toBe("number");
    expect(res.body.data.batch_id).toBe(BATCH_ID);
  });

  it("POST /batches/:id/commit emits the SAME type and value for the same batch", async () => {
    runImportPipeline.mockImplementation(async () => ({
      batchId: await realBatchId(),
      requiresReview: true,
      matchSourceCounts: {},
    }));
    const started = await api
      .post(`${BASE}/csv`)
      .query({ bank_name: "vision" })
      .expect(202);

    getBatch.mockResolvedValue({ id: BATCH_ID, status: "awaiting_review" });
    commitImport.mockResolvedValue({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    const committed = await api
      .post(`${BASE}/batches/${BATCH_ID}/commit`)
      .send({})
      .expect(200);

    expect(typeof committed.body.data.batch_id).toBe("number");
    // The whole point of the finding: strict equality across the two responses.
    expect(committed.body.data.batch_id).toStrictEqual(
      started.body.data.batch_id,
    );
  });

  it("GET /batches/:id/preview also emits a numeric batch_id", async () => {
    getPreviewRows.mockResolvedValue([]);

    const res = await api
      .get(`${BASE}/batches/${BATCH_ID}/preview`)
      .expect(200);

    expect(typeof res.body.data.batch_id).toBe("number");
  });
});
