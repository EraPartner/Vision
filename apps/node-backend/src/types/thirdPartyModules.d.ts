// Ambient ("this module exists, no type info") declarations for third-party
// packages that ship no type declarations AND have no `@types/*` package
// installed in this workspace, so a plain `import x from 'pkg'` fails
// noImplicitAny with TS7016 ("Could not find a declaration file for module").
//
// `pg` and `express` hit this same wall but are only ever referenced in TYPE
// position (`import('pg').PoolClient`, `import('express').Application`), so
// the fix there is a structural JSDoc typedef describing just the slice each
// file uses (see `QueryRunner` in rows.js, `ExpressLayer`/`ExpressApp` in
// services/routeManifest.js) — no ambient declaration needed.
//
// `multer` is different: it is imported as a VALUE (`multer(...)`,
// `multer.memoryStorage()`), and TS7016 fires unconditionally on the import
// statement itself regardless of how the binding is used afterward, so no
// amount of casting at the use site avoids it. The remediation TS's own
// error message suggests is exactly this file: an 'ambient' module
// declaration. `noImplicitAny` still applies everywhere ELSE — this only
// silences the "no declaration file" complaint for the packages listed below,
// each of which then behaves as an untyped (`any`) import at its use sites,
// same as it always has.
//
// Only the legacy checkJs program (tsconfig.check.json) includes this file,
// by name in its `include`. Source files must not pull it in with a
// `/// <reference path>` comment: ambient declarations are global once
// included, so a reference would also turn `express`, `pg` and `multer` into
// `any` in the strict TypeScript program (tsconfig.json), which checks them
// against their real `@types` packages.
//
// `pg` is here for the same VALUE-import reason as `multer`: every other
// file references `pg` in TYPE position only (`import('pg').PoolClient`) and
// uses a structural typedef instead (see `QueryRunner` in rows.js), but
// database/connection.ts does `import pg from 'pg'` and calls `new
// pg.Pool(...)` — a value import TS7016 fires on regardless of use site. That
// file defines its own structural `PgPoolClient`/`PgQueryResult` typedefs to
// keep its JSDoc precise despite `pg` itself resolving to `any` here.
//
// `express` joins the list for the routes/ slice: every route file does
// `import { Router } from 'express'` (and calls `Router()`) — a VALUE import,
// same TS7016-on-the-import-statement-itself situation as `multer`/`pg`
// above. Elsewhere `express` is referenced in TYPE position only
// (`import('express').X`), which is exactly what this codebase avoids —
// `src/types/express.ts`'s structural typedefs (`ExpressRequest`,
// `ExpressResponse`, `ExpressNextFunction`, `ExpressRouter`, `ExpressHandler`)
// are the intentional replacement for that, and remain what route handlers
// are annotated with. This ambient entry only silences the import-statement
// complaint; `Router`/the returned router instance still resolve to `any`,
// same as `multer`/`pg` always have.

declare module 'multer';
declare module 'pg';
declare module 'express';
