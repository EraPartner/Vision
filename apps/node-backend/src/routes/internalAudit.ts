/**
 * Private bridge for the Electron main process. The renderer never receives the
 * per-launch bearer token. Neither the normal admin token nor loopback binding
 * alone is sufficient to authorize checkpoint writes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
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
import { parseInput } from "../lib/zodInput.ts";

const HASH = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const UPDATE_DECISIONS = [
  "checksum_verified",
  "checksum_failed",
  "install_requested",
  "install_failed",
] as const;
const VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/;

const sequenceSchema = z.int().nonnegative();
const hashSchema = z.string().regex(HASH);

/** Every bridge body is a plain JSON object of at most MAX_BODY_BYTES. */
const boundedBodySchema = z
  .record(z.string(), z.unknown())
  .refine(
    (body) => Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_BODY_BYTES,
    `exceeds ${MAX_BODY_BYTES} bytes`,
  );

const verifyBodySchema = z.strictObject({
  trustedCheckpoint: z.unknown().optional(),
});

const checkpointSchema = z.strictObject({
  sequence: sequenceSchema,
  hash: hashSchema,
  retention: z.unknown().optional(),
});

const migrationHeadsSchema = z
  .array(z.string().regex(/^[0-9a-z_]{1,64}$/))
  .max(16)
  .refine(
    (heads) => JSON.stringify(heads) === JSON.stringify([...heads].sort()),
    "must be sorted",
  );

/** A retention boundary must end strictly before the checkpoint it rides on. */
function retentionBoundarySchema(sequence: number) {
  return z.strictObject({
    through: sequenceSchema
      .min(1)
      .refine((through) => through < sequence, "must precede the checkpoint"),
    hash: hashSchema,
    domainMax: z.strictObject({
      dbEditor: sequenceSchema,
      split: sequenceSchema,
      retag: sequenceSchema,
    }),
    migrationHeads: migrationHeadsSchema,
  });
}

const readBodySchema = z.strictObject({
  trustedCheckpoint: z.unknown().optional(),
  afterSequence: z.unknown().optional(),
  limit: z.unknown().optional(),
});

const checkpointBodySchema = z.strictObject({
  sequence: sequenceSchema,
  headHash: hashSchema,
  anchorKind: z.string().min(1).max(100),
  receiptId: z.string().min(1).max(300),
  receiptHash: hashSchema,
});

const updateDecisionBodySchema = z.strictObject({
  decision: z.enum(UPDATE_DECISIONS),
  mode: z.enum(["native", "dev"]),
  version: z.string().regex(VERSION),
});

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
  const presented = match?.[1];
  if (
    typeof configured !== "string" ||
    configured.length < 32 ||
    presented === undefined ||
    !tokenEquals(presented, configured)
  ) {
    throw new UnauthorizedError("Unauthorized");
  }
}

function parseBoundedBody(body: unknown): Record<string, unknown> {
  return parseInput(boundedBodySchema, body, {
    prefix: "Invalid audit bridge request body",
  });
}

function parseVerifyBody(body: unknown) {
  const { trustedCheckpoint } = parseInput(
    verifyBodySchema,
    parseBoundedBody(body),
    { prefix: "Invalid audit verification request" },
  );
  if (trustedCheckpoint === undefined) return undefined;
  const checkpoint = parseInput(checkpointSchema, trustedCheckpoint, {
    prefix: "Invalid trusted audit checkpoint",
  });
  const retention =
    checkpoint.retention === undefined
      ? undefined
      : parseInput(
          retentionBoundarySchema(checkpoint.sequence),
          checkpoint.retention,
          { prefix: "Invalid trusted audit retention boundary" },
        );
  return {
    sequence: checkpoint.sequence,
    hash: checkpoint.hash,
    ...(retention ? { retention } : {}),
  };
}

function parseCheckpointBody(body: unknown) {
  return parseInput(checkpointBodySchema, parseBoundedBody(body), {
    prefix: "Invalid audit checkpoint metadata",
  });
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
  const read = parseInput(readBodySchema, parseBoundedBody(body), {
    prefix: "Invalid audit read request",
  });
  const trustedCheckpoint = parseVerifyBody({
    trustedCheckpoint: read.trustedCheckpoint,
  });
  const afterSequence = parseInput(
    sequenceSchema.optional(),
    read.afterSequence,
    { prefix: "Invalid audit read cursor" },
  );
  const limit = parseInput(z.int().min(1).max(500).optional(), read.limit, {
    prefix: "Invalid audit read limit",
  });
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
  return parseInput(updateDecisionBodySchema, parseBoundedBody(body), {
    prefix: "Invalid audit update decision",
  });
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
