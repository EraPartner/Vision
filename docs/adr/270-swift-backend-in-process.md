---
title: "ADR-270: Swift backend as an in-process library"
type: adr
status: accepted
date: 2026-11-06
tags:
  [
    adr,
    architecture,
    swift,
    native-app,
    backend,
    sqlite,
    openapi,
    adr-213,
    adr-263,
    adr-269,
  ]
description: "Accepted on 2026-11-06 by Tor. The Swift app's backend is ported to Swift as a library inside the app process, with no HTTP server and no new dependencies. The generated API client reaches it through an in-process transport; operations not ported yet keep going to the bundled Bun backend until each one moves. It opens the same SQLite file through the system SQLite with the same pragmas and SQL functions, and every persistence contract stays unchanged. Electron keeps the TypeScript backend."
aliases: [adr-270, swift backend, in-process backend]
related_code:
  [
    "apps/native/Package.swift",
    "apps/native/Sources/VisionNativeCore/API/APIClient.swift",
    "apps/node-backend/src/database/connection.ts",
    "apps/node-backend/src/database/sqlite/",
    "apps/node-backend/src/database/migrate.ts",
    "openapi.yaml",
  ]
---

# ADR-270: Swift backend as an in-process library

## Status

Accepted on 2026-11-06 by Tor, on two decision cards. The first, "In-process library, no HTTP",
picked how the Swift backend runs. The second ports the Electron updater to the Swift app now,
which this ADR does not cover.

This ADR amends decision 3 of [[docs/adr/269-restart-swift-port|ADR-269]], which said a native
backend comes after frontend parity with its own ADR. It takes the place of the direction in
[[docs/adr/213-vision-native-swift-backend|ADR-213]], which was withdrawn before acceptance:
Hummingbird 2, an HTTP server inside the app, and PostgresNIO.

## Date

2026-11-06

## Context

The Swift frontend is close to parity with the React frontend. Tor wants the backend ported in the
same thread and to the same standard: identical behaviour, the same optimisations, strict types,
sequential work, and everything compiled in CI.

The TypeScript backend in `apps/node-backend/src` is about 124,800 lines in 466 files. It serves
290 operations in `openapi.yaml`, of which the Swift client is generated for 302 entries. Since
[[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] it opens one SQLite file in-process through
Bun, with these settings:

- WAL journal, `synchronous = FULL`, `fullfsync`, `busy_timeout = 10000`, `trusted_schema = ON`.
- About 40 application SQL functions: `dec_*` exact decimals with PostgreSQL `NUMERIC` semantics
  on `BigInt`, the date and timestamp helpers, `vision_raise`, and the portfolio snapshot
  functions. The schema's CHECK constraints and triggers call them.

The full inventory is in the thread's backend inventory.

## Decision

1. **A library, not a server.** The Swift backend is a SwiftPM library target in `apps/native`
   that runs inside the app process. It has no HTTP listener, no port, and no third-party
   package. It uses only the SDK and the system SQLite (`import SQLite3`, version 3.39.0 or
   later, as ADR-263 requires).

2. **One client, two transports.** The generated `APIClient` stays the only way screens reach the
   backend. A routing `APITransport`:
   - sends the operations that have been ported to their Swift handlers in-process, as the same
     `APIRequest` and `APIResponse` (method, path, query, body, status, and the JSON envelope);
   - sends every other operation to the Bun backend over the existing loopback HTTP.

   Screens, the API inspector, and error handling stay the same. The ported set is a checked-in
   list of operation ids, so moving an operation is one reviewed change.

3. **Same file, same contracts.** The Swift library opens the database file the Bun backend uses,
   with the same pragmas. It registers the same application SQL functions with byte-identical
   results.
   - Exact decimals are a Swift port of `numeric.ts`, on a small arbitrary-precision integer
     written in the repository. Foundation's `Decimal` holds 38 digits and is not used for stored
     values.
   - The SQLite file format, the storage types and canonical value forms
     (`docs/reference/sqlite-sql-dialect.md`), the migration ledger, and the directory layout do
     not change.
   - The Bun backend applies the migrations until the last operation moves. The Swift library
     refuses to open a file whose `vision_migrations` head differs from the head it was built
     for.

4. **Two writers during the transition.** WAL and `busy_timeout` let both runtimes write the file.
   - An area moves as a whole: the reads and writes of its tables, in the order of the inventory.
   - Before an area moves, every Bun in-memory cache over its tables is listed. Each one either
     re-validates on `PRAGMA data_version` or moves with the area.
   - No Swift write may leave a Bun cache stale.

5. **Parity is checked by contract tests.** A Bun script runs a fixed set of requests per
   operation against the TypeScript backend, on a database built by the migrations and the Demo
   seed. It checks in each request and response as a parity corpus, the way the generated
   fixtures are checked in.
   - Each ported operation's Swift tests replay its corpus against the Swift handler on the same
     database, and compare the JSON responses semantically.
   - The tests run in the existing `swift` CI job, and no new job is added.
   - The SQL function tests replay the TypeScript implementation's own test cases.

6. **Order of work.** Sequential phases, one pull request each:
   - 6b: persistence. Connection, pragmas, SQL functions, exact decimals, the timestamp and date
     helpers, typed row decoding, the ledger check, and the routing transport with an empty
     ported list.
   - 6c onwards: the inventory areas in order. Reference data, then transactions and imports,
     portfolio, aggregations, Belgian tax, analysis, research, AI, and admin.
   - Last: the migrator, backups, and restore move. A separate ADR then drops Bun from the Swift
     app's payload.

7. **Types.** Handlers follow the [[docs/adr/252-swift-type-strictness|ADR-252]] rules that
   ADR-269 restored: per-entity identifier types and typed rows. They decode request bodies into
   the generated `Codable` types, not untyped JSON.

8. **Electron is unchanged.** It keeps the TypeScript backend. Any backend behaviour change before
   the switch-over lands in both backends.

## Consequences

- The Swift app has no port to secure and no server lifecycle for ported operations. Calls cost a
  function call instead of a loopback round trip.
- During the transition the Swift app still ships and supervises Bun, and two runtimes share one
  database file. Rule 4 is the guard against stale reads.
- Backend changes land twice until Bun is dropped from the Swift app.
- The decimal and date functions are the riskiest code to port. They are ported and tested first
  in 6b, against the TypeScript implementation's cases.
- No new dependency and no new CI job. Swift CI time grows with the tests.

## Related

- [[docs/adr/269-restart-swift-port|ADR-269: Restart the Swift port]]
- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263: SQLite replaces PostgreSQL]]
- [[docs/adr/213-vision-native-swift-backend|ADR-213: Swift backend (withdrawn)]]
- [[docs/architecture/native-app|Native app architecture]]
- [[docs/adr/index|All ADRs]]
