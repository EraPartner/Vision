#!/usr/bin/env node
import path from "node:path";

import { appRoot } from "../paths";
import { preparePostgresRuntime } from "./prepare-postgres-runtime";
import { assertSafeNativeDestination } from "./prepare-native-runtime";

const outputRoot = assertSafeNativeDestination(
  process.env.VISION_NATIVE_RUNTIME_DESTINATION ||
    path.resolve(appRoot, "native-runtime"),
);

export function run(): void {
  const postgres = preparePostgresRuntime({
    sourceBin: process.env.VISION_POSTGRES_SOURCE_BIN,
    destination: path.join(outputRoot, "postgres"),
  });
  console.log(
    `Prepared native development services: PostgreSQL ${postgres.postgresVersion}`,
  );
}

if (require.main === module) run();
