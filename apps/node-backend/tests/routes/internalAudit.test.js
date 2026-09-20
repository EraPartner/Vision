import { describe, expect, it, vi } from "vitest";
import {
  __assertAuditBridgeAccess as assertAuditBridgeAccess,
  __executeAuditCheckpoint as executeAuditCheckpoint,
  __executeAuditVerification as executeAuditVerification,
  __parseCheckpointBody as parseCheckpointBody,
  __parseVerifyBody as parseVerifyBody,
  __parseUpdateDecisionBody as parseUpdateDecisionBody,
  __executeAuditUpdateDecision as executeAuditUpdateDecision,
  __executeAuditRead as executeAuditRead,
  __parseReadBody as parseReadBody,
} from "../../src/routes/internalAudit.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const TOKEN = "c".repeat(64);

function request({
  address = "::ffff:127.0.0.1",
  authorization = `Bearer ${TOKEN}`,
} = {}) {
  return {
    socket: { remoteAddress: address },
    headers: { authorization, "x-forwarded-for": "127.0.0.1" },
  };
}

describe("Electron audit bridge access", () => {
  it("accepts only loopback with the per-launch bearer", () => {
    expect(() => assertAuditBridgeAccess(request(), () => TOKEN)).not.toThrow();
    expect(() =>
      assertAuditBridgeAccess(request({ address: "::1" }), () => TOKEN),
    ).not.toThrow();
    expect(() =>
      assertAuditBridgeAccess(request({ address: "192.168.1.5" }), () => TOKEN),
    ).toThrow("loopback");
    expect(() =>
      assertAuditBridgeAccess(
        request({ authorization: `Bearer ${OTHER_HASH}` }),
        () => TOKEN,
      ),
    ).toThrow("Unauthorized");
    expect(() => assertAuditBridgeAccess(request(), () => undefined)).toThrow(
      "Unauthorized",
    );
    expect(() => assertAuditBridgeAccess(request(), () => "short")).toThrow(
      "Unauthorized",
    );
    expect(() =>
      assertAuditBridgeAccess(request({ authorization: null }), () => TOKEN),
    ).toThrow("Unauthorized");
  });
});

describe("Electron audit bridge requests", () => {
  it("accepts only bounded audit read cursors and trusted checkpoints", async () => {
    const body = {
      trustedCheckpoint: { sequence: 3, hash: HASH },
      afterSequence: 1,
      limit: 25,
    };
    const read = vi
      .fn()
      .mockResolvedValue({ verification: { status: "verified" }, entries: [] });
    await expect(executeAuditRead(body, read)).resolves.toEqual({
      verification: { status: "verified" },
      entries: [],
    });
    expect(read).toHaveBeenCalledWith(body);
    for (const invalid of [
      { ...body, afterSequence: -1 },
      { ...body, limit: 501 },
      { ...body, trustedCheckpoint: { sequence: 3, hash: "bad" } },
      { ...body, extra: true },
    ]) {
      expect(() => parseReadBody(invalid)).toThrow();
    }
  });

  it("records only bounded update decisions", async () => {
    const body = {
      decision: "checksum_verified",
      mode: "native",
      version: "v1.2.3-rc.1",
    };
    const record = vi.fn().mockResolvedValue({ sequence: 8, hash: HASH });
    await expect(executeAuditUpdateDecision(body, record)).resolves.toEqual({
      sequence: 8,
      hash: HASH,
    });
    expect(record).toHaveBeenCalledWith(body);
    for (const invalid of [
      { ...body, decision: "installed" },
      { ...body, mode: "remote" },
      { ...body, version: "../../installer" },
      { ...body, version: "v" + "1".repeat(65) },
      { ...body, url: "https://example.invalid/" },
    ]) {
      expect(() => parseUpdateDecisionBody(invalid)).toThrow();
    }
  });

  it("allows an unanchored bootstrap and preserves the verification status", async () => {
    const verify = vi.fn().mockResolvedValue({
      status: "unavailable",
      reason: "trusted_checkpoint_absent",
      sequence: 3,
      hash: HASH,
    });
    await expect(executeAuditVerification({}, verify)).resolves.toEqual({
      status: "unavailable",
      reason: "trusted_checkpoint_absent",
      sequence: 3,
      hash: HASH,
    });
    expect(verify).toHaveBeenCalledWith({ trustedCheckpoint: undefined });
  });

  it.each(["verified", "partially_verified", "failed"])(
    "passes through %s for Electron's recovery decision",
    async (status) => {
      const result = { status, sequence: 4, hash: HASH };
      const verify = vi.fn().mockResolvedValue(result);
      await expect(
        executeAuditVerification(
          { trustedCheckpoint: { sequence: 3, hash: OTHER_HASH } },
          verify,
        ),
      ).resolves.toBe(result);
      expect(verify).toHaveBeenCalledWith({
        trustedCheckpoint: { sequence: 3, hash: OTHER_HASH },
      });
    },
  );

  it("rejects malformed and oversized verification bodies", () => {
    expect(() =>
      parseVerifyBody({ trustedCheckpoint: { sequence: -1, hash: HASH } }),
    ).toThrow();
    expect(() =>
      parseVerifyBody({ trustedCheckpoint: { sequence: 1, hash: "bad" } }),
    ).toThrow();
    expect(() => parseVerifyBody({ extra: 1 })).toThrow();
    expect(() =>
      parseVerifyBody({
        trustedCheckpoint: { sequence: 1, hash: HASH, extra: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseVerifyBody({
        trustedCheckpoint: { sequence: 1, hash: HASH },
        padding: "x".repeat(4096),
      }),
    ).toThrow();
  });

  it("accepts a complete signed retention boundary and rejects forged shapes", () => {
    const retention = {
      through: 2,
      hash: OTHER_HASH,
      domainMax: { dbEditor: 4, split: 5, retag: 6 },
      migrationHeads: ["0118_audit_retention_pruner"],
    };
    const checkpoint = { sequence: 3, hash: HASH, retention };
    expect(parseVerifyBody({ trustedCheckpoint: checkpoint })).toEqual(
      checkpoint,
    );
    for (const invalid of [
      { ...retention, through: 3 },
      { ...retention, hash: "bad" },
      { ...retention, domainMax: { ...retention.domainMax, split: -1 } },
      { ...retention, migrationHeads: ["bad/head"] },
      { ...retention, extra: true },
    ]) {
      expect(() =>
        parseVerifyBody({
          trustedCheckpoint: { ...checkpoint, retention: invalid },
        }),
      ).toThrow();
    }
  });

  it("validates checkpoint metadata and delegates storage", async () => {
    const body = {
      sequence: 3,
      headHash: HASH,
      anchorKind: "electron-local-v1",
      receiptId: "receipt-3",
      receiptHash: OTHER_HASH,
    };
    const record = vi
      .fn()
      .mockResolvedValue({ id: 12, createdAt: "2026-09-20" });
    await expect(executeAuditCheckpoint(body, record)).resolves.toEqual({
      id: 12,
      createdAt: "2026-09-20",
    });
    expect(record).toHaveBeenCalledWith(body);
    expect(() =>
      parseCheckpointBody({ ...body, receiptHash: "bad" }),
    ).toThrow();
    expect(() => parseCheckpointBody({ ...body, extra: "x" })).toThrow();
  });

  it("maps a mismatched stored chain entry to conflict without disclosing details", async () => {
    const body = {
      sequence: 3,
      headHash: HASH,
      anchorKind: "electron-local-v1",
      receiptId: "receipt-3",
      receiptHash: OTHER_HASH,
    };
    const record = vi
      .fn()
      .mockRejectedValue(
        new Error("Audit checkpoint is ahead of current head"),
      );
    await expect(executeAuditCheckpoint(body, record)).rejects.toMatchObject({
      status: 409,
      message: "Audit checkpoint does not match stored history",
    });
  });
});
