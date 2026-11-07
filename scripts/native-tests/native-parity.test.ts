import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AREAS, PARITY_DIR } from "../native-parity.ts";

// Recording needs the TypeScript backend, so CI does not re-record; it checks that each
// checked-in corpus still holds the seed and the requests native-parity.ts sends.
for (const [name, area] of Object.entries(AREAS)) {
  void test(`parity corpus ${name}.json matches its area`, () => {
    const corpus = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, `${name}.json`), "utf8")) as {
      seed: string[];
      steps: Record<string, unknown>[];
    };
    assert.deepEqual(corpus.seed, area.seed);
    const requests = corpus.steps.map(({ status: _status, response: _response, ...request }) => request);
    assert.deepEqual(requests, area.steps);
  });
}
