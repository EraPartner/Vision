import {
  appendAuditEvent,
  recordAuditCheckpoint,
} from "../repositories/auditChainRepository.js";

/** The repository checks the externally anchored entry under lock. */
export async function recordElectronAuditCheckpoint(receipt) {
  return recordAuditCheckpoint(receipt);
}

/** Append a narrowly scoped Electron update decision; never accept paths or URLs. */
export async function recordElectronUpdateDecision(decision) {
  const entry = await appendAuditEvent({
    stream: "release_update",
    actor: "electron_main",
    eventTime: new Date().toISOString(),
    decision: decision.decision,
    mode: decision.mode,
    version: decision.version,
  });
  return { sequence: entry.sequence, hash: entry.hash };
}
