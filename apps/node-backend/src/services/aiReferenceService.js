import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { AI_REVERSIBLE_REFERENCE_TYPES } from "@vision/types/aiResearch";
import settings from "../config/config.js";
import * as repository from "../repositories/aiReferenceRepository.js";

const PRIVATE_MARKER_PREFIX = "[[vision-ref:";
const PRIVATE_MARKER = /\[\[vision-ref:([a-z]+)\|([^\]\r\n]{1,500})\]\]/g;
const TOKEN = /\[\[VR1:([a-z]+):([A-Za-z0-9_-]{24})\]\]/g;
const TOKEN_PREFIX_PATTERN = /\[\[vr1:/i;
const PREVIEW_TTL_MS = 15 * 60_000;
const CLAIMED_TTL_MS = 30 * 24 * 60 * 60_000;
const allowedTypes = new Set(AI_REVERSIBLE_REFERENCE_TYPES);

function fail(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function mappingKey(raw = settings.aiResearch.referenceMappingKey) {
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 && key.toString("base64") === raw ? key : null;
}

function aad(scopeId, token, referenceType) {
  return Buffer.from(`${scopeId}\0${token}\0${referenceType}`, "utf8");
}

function encryptValue(value, { key, scopeId, token, referenceType, random }) {
  const nonce = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(scopeId, token, referenceType));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function decryptValue(entry, key, scopeId) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, entry.nonce);
    decipher.setAAD(aad(scopeId, entry.token, entry.referenceType));
    decipher.setAuthTag(entry.authTag);
    return Buffer.concat([
      decipher.update(entry.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw fail(
      "The local reference mapping cannot be decrypted with this installation key",
      "REFERENCE_KEY_MISMATCH",
      409,
    );
  }
}

function tokenizeText(text, createToken) {
  if (!text) return { text, entries: [] };
  const entries = [];
  const tokenized = text.replace(
    PRIVATE_MARKER,
    (_match, referenceType, value) => {
      if (!allowedTypes.has(referenceType))
        throw fail(
          `Unsupported reversible reference type: ${referenceType}`,
          "REFERENCE_TYPE_UNSUPPORTED",
        );
      const normalized = String(value);
      const entry = createToken(referenceType, normalized);
      entries.push(entry);
      return entry.token;
    },
  );
  if (tokenized.includes(PRIVATE_MARKER_PREFIX))
    throw fail(
      "Malformed reversible reference. Use [[vision-ref:type|value]]",
      "REFERENCE_MARKER_MALFORMED",
    );
  return { text: tokenized, entries };
}

export async function prepareReferencePreview(
  request,
  {
    key = mappingKey(),
    random = randomBytes,
    createId = randomUUID,
    createScope = repository.createScope,
    cleanup = repository.deleteExpiredUnclaimed,
  } = {},
) {
  if (
    request.publicQuestion?.includes(PRIVATE_MARKER_PREFIX) ||
    TOKEN_PREFIX_PATTERN.test(request.publicQuestion ?? "")
  )
    throw fail(
      "Reversible references are allowed only in selected summary or selected evidence",
      "REFERENCE_FIELD_NOT_ALLOWED",
    );
  const sourceValues = [request.selectedSummary, request.selectedEvidence]
    .filter(Boolean)
    .join("\n");
  if (!sourceValues.includes(PRIVATE_MARKER_PREFIX))
    return { request: { ...request, referenceScopeId: null }, scope: null };
  if (!key)
    throw fail(
      "Reversible references require a configured local mapping key",
      "REFERENCE_KEY_UNAVAILABLE",
      503,
    );
  await cleanup();
  const scopeId = createId();
  const byValue = new Map();
  const createToken = (referenceType, value) => {
    const identity = `${referenceType}\0${value}`;
    if (byValue.has(identity)) return byValue.get(identity);
    const token = `[[VR1:${referenceType}:${random(18).toString("base64url")}]]`;
    const encrypted = encryptValue(value, {
      key,
      scopeId,
      token,
      referenceType,
      random,
    });
    const entry = { token, referenceType, ...encrypted };
    byValue.set(identity, entry);
    return entry;
  };
  const summary = tokenizeText(request.selectedSummary, createToken);
  const evidence = tokenizeText(request.selectedEvidence, createToken);
  const entries = [...new Set([...summary.entries, ...evidence.entries])];
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  try {
    await createScope({ id: scopeId, expiresAt, entries });
  } catch (error) {
    if (error?.code === "23505")
      throw fail(
        "A secure reference token collided; create a fresh preview",
        "REFERENCE_TOKEN_COLLISION",
        409,
      );
    throw error;
  }
  return {
    request: {
      ...request,
      selectedSummary: summary.text,
      selectedEvidence: evidence.text,
      referenceScopeId: scopeId,
    },
    scope: { id: scopeId, expiresAt, count: entries.length },
  };
}

function assertTokenSet(text, known) {
  if (!text) return;
  for (const match of text.matchAll(TOKEN)) {
    const entry = known.get(match[0]);
    if (!entry || entry.referenceType !== match[1])
      throw fail(
        "The outbound text contains a reference from another scope",
        "REFERENCE_SCOPE_MISMATCH",
        409,
      );
  }
  if (TOKEN_PREFIX_PATTERN.test(text)) {
    const withoutKnown = text.replace(TOKEN, "");
    if (TOKEN_PREFIX_PATTERN.test(withoutKnown))
      throw fail(
        "The outbound text contains a malformed reference token",
        "REFERENCE_TOKEN_MALFORMED",
        409,
      );
  }
}

export async function validateReferenceRequest(
  request,
  getScope = repository.getScope,
) {
  if (
    request.selectedSummary?.includes(PRIVATE_MARKER_PREFIX) ||
    request.selectedEvidence?.includes(PRIVATE_MARKER_PREFIX)
  )
    throw fail(
      "Private reference markers must be converted by a fresh disclosure preview",
      "REFERENCE_PREVIEW_REQUIRED",
      409,
    );
  if (!request.referenceScopeId) {
    assertTokenSet(request.selectedSummary, new Map());
    assertTokenSet(request.selectedEvidence, new Map());
    return null;
  }
  const scope = await getScope(request.referenceScopeId);
  if (
    !scope ||
    scope.jobId ||
    new Date(scope.expiresAt).getTime() <= Date.now()
  )
    throw fail(
      "The reversible reference preview expired or was already used",
      "REFERENCE_SCOPE_INACTIVE",
      409,
    );
  const known = new Map(scope.entries.map((entry) => [entry.token, entry]));
  assertTokenSet(request.selectedSummary, known);
  assertTokenSet(request.selectedEvidence, known);
  return scope;
}

export function claimedReferenceExpiry(now = Date.now()) {
  return new Date(now + CLAIMED_TTL_MS).toISOString();
}

function restoreText(text, values) {
  if (!text) return text;
  const restored = text.replace(TOKEN, (match, referenceType) => {
    const entry = values.get(match);
    if (!entry || entry.referenceType !== referenceType)
      throw fail(
        "The provider response contains an unknown or cross-investigation reference",
        "REFERENCE_RESTORE_REJECTED",
        409,
      );
    return entry.value;
  });
  if (TOKEN_PREFIX_PATTERN.test(restored))
    throw fail(
      "The provider response contains a malformed reference",
      "REFERENCE_RESTORE_REJECTED",
      409,
    );
  return restored;
}

export async function restoreAnswerForJob(
  jobId,
  answer,
  { key = mappingKey(), getScope = repository.getScopeForJob } = {},
) {
  const scope = await getScope(jobId);
  if (!scope) return restoreAnswerText(answer, new Map());
  if (new Date(scope.expiresAt).getTime() <= Date.now())
    throw fail(
      "The local reference mapping expired before the response could be restored",
      "REFERENCE_SCOPE_EXPIRED",
      409,
    );
  if (!key)
    throw fail(
      "The local reference mapping key is unavailable",
      "REFERENCE_KEY_UNAVAILABLE",
      503,
    );
  const values = new Map(
    scope.entries.map((entry) => [
      entry.token,
      {
        referenceType: entry.referenceType,
        value: decryptValue(entry, key, scope.id),
      },
    ]),
  );
  return restoreAnswerText(answer, values);
}

function restoreAnswerText(answer, values) {
  const structuralFields = {
    ...answer,
    summary: "",
    facts: answer.facts.map(({ text: _text, ...item }) => item),
    calculations: answer.calculations.map(({ text: _text, ...item }) => item),
    interpretations: answer.interpretations.map(
      ({ text: _text, ...item }) => item,
    ),
    assumptions: [],
    missingInformation: [],
    conflicts: answer.conflicts.map(
      ({ description: _description, ...item }) => item,
    ),
    evidence: answer.evidence.map(({ excerpt: _excerpt, ...item }) => item),
  };
  if (TOKEN_PREFIX_PATTERN.test(JSON.stringify(structuralFields)))
    throw fail(
      "The provider response placed a reference outside an allowlisted display field",
      "REFERENCE_RESTORE_REJECTED",
      409,
    );
  return {
    ...answer,
    summary: restoreText(answer.summary, values),
    facts: answer.facts.map((item) => ({
      ...item,
      text: restoreText(item.text, values),
    })),
    calculations: answer.calculations.map((item) => ({
      ...item,
      text: restoreText(item.text, values),
    })),
    interpretations: answer.interpretations.map((item) => ({
      ...item,
      text: restoreText(item.text, values),
    })),
    assumptions: answer.assumptions.map((item) => restoreText(item, values)),
    missingInformation: answer.missingInformation.map((item) =>
      restoreText(item, values),
    ),
    conflicts: answer.conflicts.map((item) => ({
      ...item,
      description: restoreText(item.description, values),
    })),
    evidence: answer.evidence.map((item) => ({
      ...item,
      excerpt: restoreText(item.excerpt, values),
    })),
  };
}

export const REFERENCE_MARKER_EXAMPLE = "[[vision-ref:recipient|Example name]]";
