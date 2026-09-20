/**
 * Private bridge for the Electron main process. The renderer never receives the
 * per-launch bearer token. Neither the normal admin token nor loopback binding
 * alone is sufficient to authorize checkpoint writes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { isLoopbackHost } from "../middleware/adminAuth.js";
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler.js";
import {
  recordElectronAuditCheckpoint,
  recordElectronUpdateDecision,
} from "../services/auditBridgeService.js";
import { readVerifiedAuditPage } from "../services/auditReadService.js";
import {
  planAuditRetention,
  pruneAuditRetention,
} from "../services/auditRetentionService.js";
import { verifyAuditHistory } from "../services/auditVerificationService.js";

const HASH = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const UPDATE_DECISIONS = new Set([
  "checksum_verified",
  "checksum_failed",
  "install_requested",
  "install_failed",
]);
const VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Use fixed-length digests for comparison so a wrong token's length does not
 * determine which branch of timingSafeEqual runs.
 */
function tokenEquals(provided, configured) {
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(configured));
}

/** @param {import('../types/express.js').ExpressRequest} req */
function assertAuditBridgeAccess(
  req,
  getToken = () => process.env.VISION_AUDIT_BRIDGE_TOKEN,
) {
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

function assertBoundedBody(body) {
  if (
    !isPlainObject(body) ||
    Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES
  ) {
    throw new ValidationError("Invalid audit bridge request body");
  }
}

function parseVerifyBody(body) {
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
  if (
    retention !== undefined &&
    (!isPlainObject(retention) ||
      !hasOnlyKeys(retention, [
        "through",
        "hash",
        "domainMax",
        "migrationHeads",
      ]) ||
      Object.keys(retention).length !== 4 ||
      !isSequence(retention.through) ||
      retention.through < 1 ||
      retention.through >= checkpoint.sequence ||
      typeof retention.hash !== "string" ||
      !HASH.test(retention.hash) ||
      !isPlainObject(retention.domainMax) ||
      !hasOnlyKeys(retention.domainMax, ["dbEditor", "split", "retag"]) ||
      Object.keys(retention.domainMax).length !== 3 ||
      ["dbEditor", "split", "retag"].some(
        (field) => !isSequence(retention.domainMax[field]),
      ) ||
      !Array.isArray(retention.migrationHeads) ||
      retention.migrationHeads.length > 16 ||
      retention.migrationHeads.some(
        (head) => typeof head !== "string" || !/^[0-9a-z_]{1,64}$/.test(head),
      ) ||
      JSON.stringify(retention.migrationHeads) !==
        JSON.stringify([...retention.migrationHeads].sort()))
  ) {
    throw new ValidationError("Invalid trusted audit retention boundary");
  }
  return {
    sequence: checkpoint.sequence,
    hash: checkpoint.hash,
    ...(retention
      ? {
          retention: {
            through: retention.through,
            hash: retention.hash,
            domainMax: {
              dbEditor: retention.domainMax.dbEditor,
              split: retention.domainMax.split,
              retag: retention.domainMax.retag,
            },
            migrationHeads: [...retention.migrationHeads],
          },
        }
      : {}),
  };
}

function parseCheckpointBody(body) {
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

async function executeAuditVerification(body, verify = verifyAuditHistory) {
  const trustedCheckpoint = parseVerifyBody(body);
  // Return the service status unchanged. In particular, a failed verification
  // is data for the Electron recovery decision, never an HTTP success claim.
  return verify({ trustedCheckpoint });
}

function parseReadBody(body) {
  assertBoundedBody(body);
  if (!hasOnlyKeys(body, ["trustedCheckpoint", "afterSequence", "limit"])) {
    throw new ValidationError("Invalid audit read request");
  }
  const trustedCheckpoint = parseVerifyBody({
    trustedCheckpoint: body.trustedCheckpoint,
  });
  if (body.afterSequence !== undefined && !isSequence(body.afterSequence)) {
    throw new ValidationError("Invalid audit read cursor");
  }
  if (
    body.limit !== undefined &&
    (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 500)
  ) {
    throw new ValidationError("Invalid audit read limit");
  }
  return {
    trustedCheckpoint,
    afterSequence: body.afterSequence,
    limit: body.limit,
  };
}

async function executeAuditRead(body, read = readVerifiedAuditPage) {
  return read(parseReadBody(body));
}

async function executeAuditCheckpoint(
  body,
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

function parseUpdateDecisionBody(body) {
  assertBoundedBody(body);
  if (
    !hasOnlyKeys(body, ["decision", "mode", "version"]) ||
    Object.keys(body).length !== 3 ||
    !UPDATE_DECISIONS.has(body.decision) ||
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
  body,
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
