"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDockerSource,
  parseSourceEnv,
  dockerChildEnv,
} = require("./docker-source");

test("Docker source environment parsing does not expose or require passwords", () => {
  const result = parseSourceEnv(
    "DATABASE_URL_MIGRATIONS=postgresql://owner:redacted@db:5432/vision\n",
  );
  assert.deepEqual(result, { user: "owner", database: "vision" });
  assert.equal("password" in result, false);
});

test("Docker child environment excludes unrelated secrets", () => {
  const previous = process.env.VISION_IMPORT_SECRET;
  process.env.VISION_IMPORT_SECRET = "do-not-copy";
  try {
    assert.equal(dockerChildEnv().VISION_IMPORT_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.VISION_IMPORT_SECRET;
    else process.env.VISION_IMPORT_SECRET = previous;
  }
});

test("Docker preflight gives a safe database-only recovery when the service is stopped", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-docker-source-stopped-"),
  );
  try {
    await fs.promises.writeFile(
      path.join(temp, "docker-compose.yml"),
      "services:\n  db:\n    image: postgres:18-alpine\n",
    );
    const source = createDockerSource({
      workDir: temp,
      dockerBin: "/bin/echo",
      runDocker: async (args) => {
        if (args[0] === "info") return "";
        if (args.includes("ps")) return "";
        throw new Error("Unexpected Docker command");
      },
    });

    await assert.rejects(
      source.assertAvailable(),
      (error) =>
        error.code === "DOCKER_DB_NOT_RUNNING" &&
        /up -d --no-deps db/.test(error.message),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
