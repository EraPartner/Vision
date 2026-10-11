import path from "node:path";

/**
 * Root of the Electron package: packaging/electron in a checkout, the app.asar
 * root when packaged. Compiled code runs from out/, one level below it, while
 * package.json, assets/, i18n/ and the native payload stay at this root.
 */
export const appRoot = path.resolve(__dirname, "..");
