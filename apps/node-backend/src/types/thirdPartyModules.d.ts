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

declare module 'multer';
