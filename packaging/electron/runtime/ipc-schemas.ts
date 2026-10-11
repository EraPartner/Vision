// Argument contracts for every Electron invoke channel (see electron-api.d.ts).
// registerHandler() in main.js refuses to register a channel without an entry
// here, runs `validate` on the raw renderer arguments after the sender check,
// and hands the handler only the normalized result. When `validate` throws,
// the renderer receives `invalidResult` (called with the error when it is a
// function), or the invoke promise rejects for REJECT_INVALID. Each
// `invalidResult` matches the failure shape that channel's renderer caller
// already handles. Validators are plain functions because the Electron package
// ships without zod and the sandboxed preload cannot load modules.

import path from "node:path";
import { validateReadOptions } from "../audit-viewer";
import type { ElectronInvokeChannel } from "../electron-api";

export const REJECT_INVALID = Symbol("reject-invalid-ipc-arguments");

export interface IpcArgumentError extends Error {
  code?: string;
}

type IpcArguments = readonly unknown[];
type UnknownRecord = Record<string, unknown>;

type IpcFailure = Readonly<Record<string, unknown>>;

export type IpcInvalidResult =
  | typeof REJECT_INVALID
  | null
  | boolean
  | IpcFailure
  | ((error: IpcArgumentError) => IpcFailure);

export interface IpcArgumentContract {
  validate(args: IpcArguments): unknown[];
  invalidResult: IpcInvalidResult;
}

export type IpcArgumentContracts = Readonly<
  Record<ElectronInvokeChannel, IpcArgumentContract>
>;

function invalidArguments(message: string, code?: string): IpcArgumentError {
  const error: IpcArgumentError = new Error(message);
  error.name = "IpcArgumentError";
  if (code) error.code = code;
  return error;
}

// The preload passes a fixed argument list per channel; anything beyond the
// declared arity can only come from a caller that bypassed it.
function expectArity(args: IpcArguments, arity: number): void {
  if (args.slice(arity).some((value) => value !== undefined)) {
    throw invalidArguments("Unexpected IPC arguments");
  }
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Property reads on any renderer value: non-objects carry none of the fields
// these validators look at.
function fieldsOf(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function noArguments(args: IpcArguments): [] {
  expectArity(args, 0);
  return [];
}

// macOS system directories that must never be used as a backup destination.
// '/Library' is the SYSTEM-level library (a previous entry listed the
// nonexistent '/Library/System'); per-user backups live under
// /Users/<name>/Library (e.g. iCloud Drive), which this does not match.
const BLOCKED_BACKUP_PREFIXES = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/private/var/db",
  "/Library",
];

// Shared destination validation for every path that can set or use a backup
// directory (backup:run, backup:save-settings → quit-time backup). Returns an
// error string, or null when the destination is acceptable.
export function validateBackupDest(dir: unknown): string | null {
  if (typeof dir !== "string" || !dir) return "Invalid backup directory";
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved))
    return "Backup directory must be an absolute path";
  if (
    BLOCKED_BACKUP_PREFIXES.some(
      (p) => resolved === p || resolved.startsWith(p + "/"),
    )
  ) {
    return "Backup to system directories is not allowed";
  }
  return null;
}

const ALLOWED_RESTORE_EXTS = new Set([".visionbak", ".enc", ".sql"]);
export function hasAllowedRestoreExt(p: unknown): boolean {
  const lower = String(p).toLowerCase();
  if (lower.endsWith(".visionbak.enc")) return true;
  for (const ext of ALLOWED_RESTORE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

// HSL component strings only ("158 64% 52%"): digits, spaces, %, dots. The value
// is interpolated into the splash HTML/CSS, so this guards against CSS/HTML
// injection — anything outside the pattern is rejected and the slate fallback wins.
const HSL_COMPONENTS_RE =
  /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
export function isValidHslComponents(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    HSL_COMPONENTS_RE.test(value)
  );
}

// Same bounds as requireTransferPassword() in audit-anchor.js, which stays the
// authoritative check; failing here first avoids the history verification and
// file dialogs that precede it.
const TRANSFER_PASSWORD_MIN_LENGTH = 16;
const TRANSFER_PASSWORD_MAX_LENGTH = 1024;

function auditReadArguments(args: IpcArguments) {
  expectArity(args, 1);
  return [validateReadOptions(args[0])];
}

function auditTransferArguments(args: IpcArguments): [string] {
  expectArity(args, 1);
  const [password] = args;
  if (
    typeof password !== "string" ||
    password.length < TRANSFER_PASSWORD_MIN_LENGTH ||
    password.length > TRANSFER_PASSWORD_MAX_LENGTH
  ) {
    throw invalidArguments(
      "Invalid audit transfer password",
      "transfer_password_invalid",
    );
  }
  return [password];
}

function pickedRestorePath(
  filePath: unknown,
  isAllowedRestorePath: (resolvedPath: string) => boolean,
): string {
  if (typeof filePath !== "string" || !filePath) {
    throw invalidArguments("Invalid restore path");
  }
  const resolved = path.resolve(filePath);
  if (!isAllowedRestorePath(resolved)) {
    throw invalidArguments("Restore path was not selected via the file picker");
  }
  return resolved;
}

function backupRunArguments(args: IpcArguments): [string, string | null] {
  expectArity(args, 2);
  const [destDir, frontendStateJson] = args;
  const destError = validateBackupDest(destDir);
  if (destError) throw invalidArguments(destError);
  if (
    frontendStateJson !== undefined &&
    frontendStateJson !== null &&
    typeof frontendStateJson !== "string"
  ) {
    throw invalidArguments("Invalid frontend state snapshot");
  }
  // validateBackupDest rejected every non-string destination above.
  return [path.resolve(String(destDir)), frontendStateJson ?? null];
}

function backupSettingsArguments(
  args: IpcArguments,
): [{ backupDir: string; backupOnQuit: boolean }] {
  expectArity(args, 1);
  const [settings] = args;
  if (
    !isPlainObject(settings) ||
    typeof settings.backupDir !== "string" ||
    typeof settings.backupOnQuit !== "boolean"
  ) {
    throw invalidArguments("Invalid backup settings");
  }
  // An empty directory clears the setting. Anything else is validated now
  // because the quit-time backup writes wherever it points, with no further checks.
  if (settings.backupDir) {
    const destError = validateBackupDest(settings.backupDir);
    if (destError) throw invalidArguments(destError);
  }
  return [
    { backupDir: settings.backupDir, backupOnQuit: settings.backupOnQuit },
  ];
}

function servicesSettingsArguments(
  args: IpcArguments,
): [{ keepServicesOnQuit: boolean }] {
  expectArity(args, 1);
  const [settings] = args;
  if (
    !isPlainObject(settings) ||
    typeof settings.keepServicesOnQuit !== "boolean"
  ) {
    throw invalidArguments("Invalid services settings");
  }
  return [{ keepServicesOnQuit: settings.keepServicesOnQuit }];
}

function backupPassphraseArguments(args: IpcArguments): [string] {
  expectArity(args, 1);
  const [passphrase] = args;
  if (typeof passphrase !== "string") {
    throw invalidArguments("Invalid backup passphrase");
  }
  return [passphrase];
}

const RENDERER_FAILURE_KINDS = ["error", "resource", "unhandledrejection"];

// Diagnostics never fail: unexpected fields collapse to fixed placeholders so
// only structural metadata reaches the log.
function rendererFailureArguments(
  args: IpcArguments,
): [{ kind: string; name: string; source: string; line: number }] {
  const payload = fieldsOf(args[0]);
  const kind =
    typeof payload?.kind === "string" &&
    RENDERER_FAILURE_KINDS.includes(payload.kind)
      ? payload.kind
      : "error";
  const name =
    typeof payload?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(payload.name)
      ? payload.name
      : "UnknownError";
  const source =
    typeof payload?.source === "string" &&
    /^[A-Za-z0-9_.-]{1,160}$/.test(payload.source)
      ? payload.source
      : "unknown";
  const line =
    typeof payload?.line === "number" && Number.isSafeInteger(payload.line)
      ? payload.line
      : 0;
  return [{ kind, name, source, line }];
}

function badgeCountArguments(args: IpcArguments): [number] {
  expectArity(args, 1);
  const n = Number(args[0]);
  if (!Number.isFinite(n)) throw invalidArguments("Invalid badge count");
  return [Math.max(0, Math.min(999, Math.floor(n)))];
}

function languageArguments(args: IpcArguments): ["en" | "nl"] {
  expectArity(args, 1);
  const [language] = args;
  if (language !== "en" && language !== "nl") {
    throw invalidArguments("Unsupported language");
  }
  return [language];
}

function vibrancyArguments(args: IpcArguments): [boolean] {
  expectArity(args, 1);
  const [enabled] = args;
  if (typeof enabled !== "boolean") {
    throw invalidArguments("Invalid vibrancy flag");
  }
  return [enabled];
}

function splashThemeArguments(args: IpcArguments) {
  expectArity(args, 1);
  const colors = fieldsOf(args[0]);
  if (
    !colors ||
    !isValidHslComponents(colors.background) ||
    !isValidHslComponents(colors.foreground) ||
    (colors.mode != null &&
      colors.mode !== "light" &&
      colors.mode !== "dark") ||
    (colors.surface != null && !isValidHslComponents(colors.surface)) ||
    (colors.text != null && !isValidHslComponents(colors.text))
  ) {
    throw invalidArguments("Invalid splash theme colors");
  }
  return [
    {
      mode: colors.mode,
      background: colors.background,
      foreground: colors.foreground,
      surface: colors.surface,
      text: colors.text,
    },
  ];
}

const errorResult = (error: IpcArgumentError) => ({
  success: false,
  error: error.message,
});
const failedAuditRead = (error: IpcArgumentError) => ({
  success: false,
  status: "failed",
  error: error.message,
});
const failedAuditTransfer = (error: IpcArgumentError) => ({
  success: false,
  status: "failed",
  reason: error.code || "transfer_failed",
});

export interface IpcArgumentContractDependencies {
  /** true only for paths blessed by the backup:select-file picker. */
  isAllowedRestorePath: (resolvedPath: string) => boolean;
}

export function createIpcArgumentContracts({
  isAllowedRestorePath,
}: IpcArgumentContractDependencies): IpcArgumentContracts {
  return Object.freeze({
    "update:check-github": {
      validate: noArguments,
      invalidResult: REJECT_INVALID,
    },
    "update:install-shell": {
      validate: noArguments,
      invalidResult: errorResult,
    },
    "update:pre-update-backup": {
      validate: noArguments,
      invalidResult: errorResult,
    },
    "backup:run": { validate: backupRunArguments, invalidResult: errorResult },
    "backup:select-dir": { validate: noArguments, invalidResult: null },
    "backup:select-file": { validate: noArguments, invalidResult: null },
    "backup:restore": {
      validate(args: IpcArguments) {
        expectArity(args, 2);
        const [filePath, opts] = args;
        const resolved = pickedRestorePath(filePath, isAllowedRestorePath);
        if (!hasAllowedRestoreExt(resolved)) {
          throw invalidArguments("Unsupported backup file extension");
        }
        const passphrase = isPlainObject(opts) ? opts.passphrase : undefined;
        if (passphrase != null && typeof passphrase !== "string") {
          throw invalidArguments("Invalid restore passphrase");
        }
        return [resolved, { passphrase: passphrase ?? undefined }];
      },
      invalidResult: errorResult,
    },
    "backup:is-encrypted": {
      validate(args: IpcArguments) {
        expectArity(args, 1);
        return [pickedRestorePath(args[0], isAllowedRestorePath)];
      },
      invalidResult: false,
    },
    "backup:save-settings": {
      validate: backupSettingsArguments,
      invalidResult: errorResult,
    },
    "backup:load-settings": {
      validate: noArguments,
      invalidResult: REJECT_INVALID,
    },
    "backup:get-encryption-status": {
      validate: noArguments,
      invalidResult: REJECT_INVALID,
    },
    "backup:set-passphrase": {
      validate: backupPassphraseArguments,
      invalidResult: (error: IpcArgumentError) => ({
        success: false,
        available: false,
        error: error.message,
      }),
    },
    "services:save-settings": {
      validate: servicesSettingsArguments,
      invalidResult: errorResult,
    },
    "services:load-settings": {
      validate: noArguments,
      invalidResult: REJECT_INVALID,
    },
    "audit:enroll": { validate: noArguments, invalidResult: errorResult },
    "audit:read": {
      validate: auditReadArguments,
      invalidResult: failedAuditRead,
    },
    "audit:export": { validate: noArguments, invalidResult: errorResult },
    "audit:transfer-export": {
      validate: auditTransferArguments,
      invalidResult: failedAuditTransfer,
    },
    "audit:transfer-import": {
      validate: auditTransferArguments,
      invalidResult: failedAuditTransfer,
    },
    "audit:rotate-key": { validate: noArguments, invalidResult: errorResult },
    "recovery:retry": { validate: noArguments, invalidResult: errorResult },
    "recovery:open-logs": { validate: noArguments, invalidResult: errorResult },
    "app:renderer-failure": {
      validate: rendererFailureArguments,
      invalidResult: { success: false },
    },
    "app:renderer-ready": {
      validate: noArguments,
      invalidResult: { success: false },
    },
    "app:set-badge": {
      validate: badgeCountArguments,
      invalidResult: { success: false },
    },
    "app:set-language": {
      validate: languageArguments,
      invalidResult: { success: false },
    },
    "app:set-vibrancy": {
      validate: vibrancyArguments,
      invalidResult: { success: false },
    },
    "app:get-accent-color": { validate: noArguments, invalidResult: null },
    "theme:persist-splash": {
      validate: splashThemeArguments,
      invalidResult: { success: false },
    },
  });
}
