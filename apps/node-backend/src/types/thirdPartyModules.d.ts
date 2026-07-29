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
// tsconfig.check(.strict).json's `include` is `src/**/*.js`, which does not
// pick up `.d.ts` files on its own; a consuming file pulls this in with a
// `/// <reference path="../types/thirdPartyModules.d.ts" />` comment, after
// which the ambient declarations below are visible to the whole program
// (ambient declarations are global once included, not per-importer).
//
// `pg` is here for the same VALUE-import reason as `multer`: every other
// file references `pg` in TYPE position only (`import('pg').PoolClient`) and
// uses a structural typedef instead (see `QueryRunner` in rows.js), but
// database/connection.js does `import pg from 'pg'` and calls `new
// pg.Pool(...)` — a value import TS7016 fires on regardless of use site. That
// file defines its own structural `PgPoolClient`/`PgQueryResult` typedefs to
// keep its JSDoc precise despite `pg` itself resolving to `any` here.
//
// `express` joins the list for the routes/ slice: every route file does
// `import { Router } from 'express'` (and calls `Router()`) — a VALUE import,
// same TS7016-on-the-import-statement-itself situation as `multer`/`pg`
// above. Elsewhere `express` is referenced in TYPE position only
// (`import('express').X`), which is exactly what this codebase avoids —
// `src/types/express.js`'s structural typedefs (`ExpressRequest`,
// `ExpressResponse`, `ExpressNextFunction`, `ExpressRouter`, `ExpressHandler`)
// are the intentional replacement for that, and remain what route handlers
// are annotated with. This ambient entry only silences the import-statement
// complaint; `Router`/the returned router instance still resolve to `any`,
// same as `multer`/`pg` always have.

declare module 'multer';
declare module 'pg';
declare module 'express';
