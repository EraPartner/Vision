/**
 * Private bridge for the Electron main process. The renderer never receives the
 * per-launch bearer token. Neither the normal admin token nor loopback binding
 * alone is sufficient to authorize checkpoint writes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { ExpressRequest } from "../types/express.ts";
import { isLoopbackHost } from "../middleware/adminAuth.ts";
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import {
  recordElectronAuditCheckpoint,
  recordElectronUpdateDecision,
} from "../services/auditBridgeService.ts";
import { readVerifiedAuditPage } from "../services/auditReadService.ts";
import {
  planAuditRetention,
  pruneAuditRetention,
} from "../services/auditRetentionService.ts";
import { verifyAuditHistory } from "../services/auditVerificationService.ts";

const HASH = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const UPDATE_DECISIONS = new Set([
  "checksum_verified",
  "checksum_failed",
  "install_requested",
  "install_failed",
]);
const VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Use fixed-length digests for comparison so a wrong token's length does not
 * determine which branch of timingSafeEqual runs.
 */
function tokenEquals(provided: string, configured: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(configured));
}

function assertAuditBridgeAccess(
  // Only the peer socket and headers are read. A `router.use` request carries
  // Express 5's `string | string[]` params, which full ExpressRequest rejects.
  req: Pick<ExpressRequest, "socket" | "headers">,
  getToken: () => string | undefined = () =>
    process.env.VISION_AUDIT_BRIDGE_TOKEN,
): void {
  // socket.remoteAddress is the peer address. req.ip can be derived from an
  // untrusted X-Forwarded-For header when proxy trust is configured.
  if (!isLoopbackHost(req.socket?.remoteAddress)) {
    throw new ForbiddenError("Audit bridge requires a loopback connection");
  }
  const configured = getToken();
  const header = req.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  if (
    typeof configured !== "string" ||
    configured.length < 32 ||
    !match ||
    !tokenEquals(match[1], configured)
  ) {
    throw new UnauthorizedError("Unauthorized");
  }
}

function assertBoundedBody(
  body: unknown,
): asserts body is Record<string, unknown> {
  if (
    !isPlainObject(body) ||
    Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES
  ) {
    throw new ValidationError("Invalid audit bridge request body");
  }
}

interface TrustedRetentionBoundary {
  through: number;
  hash: string;
  domainMax: { dbEditor: number; split: number; retag: number };
  migrationHeads: string[];
}

function isRetentionBoundary(
  retention: unknown,
  sequence: number,
): retention is TrustedRetentionBoundary {
  if (!isPlainObject(retention)) return false;
  const { domainMax, migrationHeads } = retention;
  return (
    hasOnlyKeys(retention, [
      "through",
      "hash",
      "domainMax",
      "migrationHeads",
    ]) &&
    Object.keys(retention).length === 4 &&
    isSequence(retention.through) &&
    retention.through >= 1 &&
    retention.through < sequence &&
    typeof retention.hash === "string" &&
    HASH.test(retention.hash) &&
    isPlainObject(domainMax) &&
    hasOnlyKeys(domainMax, ["dbEditor", "split", "retag"]) &&
    Object.keys(domainMax).length === 3 &&
    ["dbEditor", "split", "retag"].every((field) =>
      isSequence(domainMax[field]),
    ) &&
    Array.isArray(migrationHeads) &&
    migrationHeads.length <= 16 &&
    migrationHeads.every(
      (head: unknown) =>
        typeof head === "string" && /^[0-9a-z_]{1,64}$/.test(head),
    ) &&
    JSON.stringify(migrationHeads) ===
      JSON.stringify([...migrationHeads].sort())
  );
}

function parseVerifyBody(body: unknown) {
  assertBoundedBody(body);
  if (!hasOnlyKeys(body, ["trustedCheckpoint"])) {
    throw new ValidationError("Invalid audit verification request");
  }
  if (body.trustedCheckpoint === undefined) return undefined;
  const checkpoint = body.trustedCheckpoint;
  if (
    !isPlainObject(checkpoint) ||
    !hasOnlyKeys(checkpoint, ["sequence", "hash", "retention"]) ||
    !isSequence(checkpoint.sequence) ||
    typeof checkpoint.hash !== "string" ||
    !HASH.test(checkpoint.hash)
  ) {
    throw new ValidationError("Invalid trusted audit checkpoint");
  }
  const retention = checkpoint.retention;
  let boundary: TrustedRetentionBoundary | undefined;
  if (retention !== undefined) {
    if (!isRetentionBoundary(retention, checkpoint.sequence)) {
      throw new ValidationError("Invalid trusted audit retention boundary");
    }
    boundary = retention;
  }
  return {
    sequence: checkpoint.sequence,
    hash: checkpoint.hash,
    ...(boundary
      ? {
          retention: {
            through: boundary.through,
            hash: boundary.hash,
            domainMax: {
              dbEditor: boundary.domainMax.dbEditor,
              split: boundary.domainMax.split,
              retag: boundary.domainMax.retag,
            },
            migrationHeads: [...boundary.migrationHeads],
          },
        }
      : {}),
  };
}

function parseCheckpointBody(body: unknown) {
  assertBoundedBody(body);
  if (
    !hasOnlyKeys(body, [
      "sequence",
      "headHash",
      "anchorKind",
      "receiptId",
      "receiptHash",
    ]) ||
    !isSequence(body.sequence) ||
    typeof body.headHash !== "string" ||
    !HASH.test(body.headHash) ||
    typeof body.receiptHash !== "string" ||
    !HASH.test(body.receiptHash) ||
    typeof body.anchorKind !== "string" ||
    body.anchorKind.length < 1 ||
    body.anchorKind.length > 100 ||
    typeof body.receiptId !== "string" ||
    body.receiptId.length < 1 ||
    body.receiptId.length > 300 ||
    Object.keys(body).length !== 5
  ) {
    throw new ValidationError("Invalid audit checkpoint metadata");
  }
  return {
    sequence: body.sequence,
    headHash: body.headHash,
    anchorKind: body.anchorKind,
    receiptId: body.receiptId,
    receiptHash: body.receiptHash,
  };
}

async function executeAuditVerification(
  body: unknown,
  verify = verifyAuditHistory,
) {
  const trustedCheckpoint = parseVerifyBody(body);
  // Return the service status unchanged. In particular, a failed verification
  // is data for the Electron recovery decision, never an HTTP success claim.
  return verify({ trustedCheckpoint });
}

function parseReadBody(body: unknown) {
  assertBoundedBody(body);
  if (!hasOnlyKeys(body, ["trustedCheckpoint", "afterSequence", "limit"])) {
    throw new ValidationError("Invalid audit read request");
  }
  const trustedCheckpoint = parseVerifyBody({
    trustedCheckpoint: body.trustedCheckpoint,
  });
  let afterSequence: number | undefined;
  if (body.afterSequence !== undefined) {
    if (!isSequence(body.afterSequence)) {
      throw new ValidationError("Invalid audit read cursor");
    }
    afterSequence = body.afterSequence;
  }
  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (
      typeof body.limit !== "number" ||
      !Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 500
    ) {
      throw new ValidationError("Invalid audit read limit");
    }
    limit = body.limit;
  }
  return {
    trustedCheckpoint,
    afterSequence,
    limit,
  };
}

async function executeAuditRead(body: unknown, read = readVerifiedAuditPage) {
  return read(parseReadBody(body));
}

async function executeAuditCheckpoint(
  body: unknown,
  record = recordElectronAuditCheckpoint,
) {
  const receipt = parseCheckpointBody(body);
  try {
    return await record(receipt);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Audit checkpoint is ahead of current head" ||
        error.message === "Audit checkpoint does not match stored history")
    ) {
      throw new ConflictError("Audit checkpoint does not match stored history");
    }
    throw error;
  }
}

function parseUpdateDecisionBody(body: unknown) {
  assertBoundedBody(body);
  if (
    !hasOnlyKeys(body, ["decision", "mode", "version"]) ||
    Object.keys(body).length !== 3 ||
    typeof body.decision !== "string" ||
    !UPDATE_DECISIONS.has(body.decision) ||
    typeof body.mode !== "string" ||
    !["native", "dev"].includes(body.mode) ||
    typeof body.version !== "string" ||
    !VERSION.test(body.version)
  ) {
    throw new ValidationError("Invalid audit update decision");
  }
  return {
    decision: body.decision,
    mode: body.mode,
    version: body.version,
  };
}

async function executeAuditUpdateDecision(
  body: unknown,
  record = recordElectronUpdateDecision,
) {
  return record(parseUpdateDecisionBody(body));
}

const router = Router();

router.use((req, _res, next) => {
  try {
    assertAuditBridgeAccess(req);
    next();
  } catch (error) {
    next(error);
  }
});

router.post("/verify", async (req, res) => {
  res.ok(await executeAuditVerification(req.body));
});

router.post("/read", async (req, res) => {
  res.ok(await executeAuditRead(req.body));
});

router.post("/checkpoint", async (req, res) => {
  res.ok(await executeAuditCheckpoint(req.body));
});

router.post("/retention-plan", async (req, res) => {
  const trustedCheckpoint = parseVerifyBody(req.body);
  if (!trustedCheckpoint)
    throw new ValidationError("Trusted audit checkpoint required");
  res.ok(await planAuditRetention(trustedCheckpoint));
});

router.post("/retention-prune", async (req, res) => {
  const trustedCheckpoint = parseVerifyBody(req.body);
  if (!trustedCheckpoint?.retention)
    throw new ValidationError("Signed audit retention boundary required");
  res.ok(await pruneAuditRetention(trustedCheckpoint));
});

router.post("/update-decision", async (req, res) => {
  res.ok(await executeAuditUpdateDecision(req.body));
});

export {
  assertAuditBridgeAccess as __assertAuditBridgeAccess,
  executeAuditCheckpoint as __executeAuditCheckpoint,
  executeAuditUpdateDecision as __executeAuditUpdateDecision,
  executeAuditVerification as __executeAuditVerification,
  executeAuditRead as __executeAuditRead,
  parseCheckpointBody as __parseCheckpointBody,
  parseUpdateDecisionBody as __parseUpdateDecisionBody,
  parseVerifyBody as __parseVerifyBody,
  parseReadBody as __parseReadBody,
};

export default router;
