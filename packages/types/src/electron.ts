/**
 * Electron's shared contract is type-only. Runtime channel registration stays
 * in the CommonJS desktop shell and is checked against electron-api.d.ts by the
 * Electron contract test.
 */
export type * from "../../../packaging/electron/electron-api.js";
