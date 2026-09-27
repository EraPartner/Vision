const assert = require("node:assert/strict");
const test = require("node:test");
const {
  checkMatrix,
  readSpecOperations,
} = require("../check-endpoint-matrix.js");

function spec(paths) {
  return `openapi: 3.0.3\ninfo:\n  title: Fixture\n  version: "1"\npaths:\n${paths}`;
}

function matrix(count, rows) {
  return `---\napi_operation_count: ${count}\n---\n| Method | Path | Description |\n| --- | --- | --- |\n${rows}`;
}

test("rejects a replaced endpoint even when both counts remain the same", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/current: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(1, "| GET | `/api/removed` | Old endpoint |"),
  );
  assert.deepEqual(result.errors, [
    "Missing from matrix:\n  GET /api/current",
    "Absent from OpenAPI:\n  GET /api/removed",
  ]);
});

test("expands grouped methods and normalizes Express path parameters", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items/{id}:\n    get: { responses: { '200': { description: OK } } }\n    delete: { responses: { '204': { description: Deleted } } }\n",
    ),
    matrix(2, "| GET, DELETE | `/api/items/:id` | Read or delete |"),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.count, 2);
});

test("rejects duplicate operations after normalization", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items/{id}: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(
      1,
      "| GET | `/api/items/:id` | First |\n| GET | `/api/items/{id}` | Duplicate |",
    ),
  );
  assert.match(
    result.errors[0],
    /duplicate operation GET \/api\/items\/\{id\}/,
  );
});

test("rejects wildcard rows instead of letting them stand for unknown operations", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(1, "| GET | `/api/*` | Wildcard |"),
  );
  assert.match(result.errors[0], /wildcard path/);
  assert.match(result.errors[1], /Missing from matrix/);
});

test("rejects malformed paths on HTTP operation rows instead of skipping them", async () => {
  for (const row of [
    "| POST | /api/undocumented | No backticks |",
    "| GET, POST | /api/undocumented | Group without backticks |",
    "| POST | `api/undocumented` | Missing leading slash |",
    "| POST | | Missing path |",
  ]) {
    const result = await checkMatrix(
      spec(
        "  /api/items: { get: { responses: { '200': { description: OK } } } }\n",
      ),
      matrix(1, `| GET | \`/api/items\` | Items |\n${row}`),
    );
    assert.equal(result.errors.length, 1, row);
    assert.match(result.errors[0], /invalid HTTP path/, row);
  }
});

test("ignores non-operation rows in summary and historical tables", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(
      1,
      "| GET | `/api/items` | Items |\n| Accounts | 13 | Summary |\n| `GET /api/removed` | `GET /api/replacement` | Historical |",
    ),
  );
  assert.deepEqual(result.errors, []);
});

test("excludes only the two documented GET health routes", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(
      1,
      "| GET | `/api/items` | Items |\n| GET | `/health` | Health |\n| GET | `/health/detailed` | Details |\n| POST | `/health` | Unexpected |",
    ),
  );
  assert.deepEqual(result.errors, ["Absent from OpenAPI:\n  POST /health"]);
});

test("counts all OpenAPI methods and ignores nested response keys", async () => {
  const operations = await readSpecOperations(
    spec(
      "  '/api/probe':\n    head: { responses: { '200': { description: OK } } }\n    options: { responses: { '200': { description: OK } } }\n    trace: { responses: { '200': { description: OK, content: { 'application/json': { schema: { type: object, properties: { get: { type: string } } } } } } } }\n",
    ),
  );
  assert.deepEqual([...operations].sort(), [
    "HEAD /api/probe",
    "OPTIONS /api/probe",
    "TRACE /api/probe",
  ]);
});

test("reports a stale declared count as well as missing operations", async () => {
  const result = await checkMatrix(
    spec(
      "  /api/items: { get: { responses: { '200': { description: OK } } } }\n",
    ),
    matrix(0, ""),
  );
  assert.match(result.errors[0], /api_operation_count is 0/);
  assert.match(result.errors[1], /GET \/api\/items/);
});

test("rejects malformed YAML and duplicate YAML keys", async () => {
  await assert.rejects(readSpecOperations(spec("  /api/items: [\n")));
  await assert.rejects(
    readSpecOperations(spec("  /api/items: {}\n  /api/items: {}\n")),
  );
});
