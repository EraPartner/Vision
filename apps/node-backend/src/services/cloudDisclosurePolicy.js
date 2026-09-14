import { createHash } from "node:crypto";
import { aiDisclosureGrantSchema } from "@vision/types/aiResearch";

const PAYLOAD_FIELDS = new Set([
  "question",
  "publicSchema",
  "language",
  "depth",
  "constraints",
  "selectedSummary",
  "selectedEvidence",
  "citations",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const PRIVATE_PUBLIC_TEXT_PATTERNS = [
  { label: "IBAN", pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){10,30}\b/i },
  {
    label: "payment-card or account number",
    pattern: /\b(?:\d[ -]?){12,19}\b/,
  },
  { label: "email address", pattern: /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/ },
  {
    label: "currency amount",
    pattern: /(?:[$€£]\s*\d|\b\d[\d.,]*\s*(?:EUR|USD|GBP)\b)/i,
  },
  {
    label: "private financial field",
    pattern:
      /\b(?:my|mine|our)\s+(?:account|balance|transaction|recipient|merchant|salary|holding|portfolio)\b|\b(?:account|transaction|recipient|merchant)\s*(?:id|number|name)?\s*[:=]/i,
  },
];

export function assertPublicDisclosureText(value, field = "question") {
  const text = String(value ?? "");
  for (const { label, pattern } of PRIVATE_PUBLIC_TEXT_PATTERNS) {
    if (pattern.test(text))
      throw Object.assign(
        new Error(`${field} contains ${label}; use selected-summary mode`),
        { code: "PRIVATE_TEXT_IN_PUBLIC_DISCLOSURE" },
      );
  }
  return text;
}

export function buildDisclosurePreview(input) {
  const payload = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!PAYLOAD_FIELDS.has(key))
      throw new Error(`Field is not eligible for cloud disclosure: ${key}`);
    if (value !== undefined && value !== null) payload[key] = value;
  }
  if (
    !payload.question &&
    !payload.selectedSummary &&
    !payload.selectedEvidence
  )
    throw new Error(
      "A question, selected summary, or selected evidence is required",
    );
  const serialized = canonicalJson(payload);
  const units = Object.keys(payload).map(
    (field) =>
      `${field}:${createHash("sha256").update(canonicalJson(payload[field])).digest("hex")}`,
  );
  return {
    payload,
    serialized,
    payloadSha256: createHash("sha256").update(serialized).digest("hex"),
    payloadBytes: Buffer.byteLength(serialized),
    inputCharacters: serialized.length,
    fieldManifest: Object.keys(payload).sort(),
    disclosureUnits: units.sort(),
  };
}

export function bindDisclosureToRequest(preview, requestBody) {
  const serialized = canonicalJson(requestBody);
  return {
    ...preview,
    payload: requestBody,
    disclosedPayload: preview.payload,
    serialized,
    payloadSha256: createHash("sha256").update(serialized).digest("hex"),
    payloadBytes: Buffer.byteLength(serialized),
    inputCharacters: serialized.length,
  };
}

export function validateDisclosureGrant(value) {
  const grant = aiDisclosureGrantSchema.parse(value);
  if (grant.retainExactPayload)
    throw new Error("Exact cloud payload retention is not supported");
  if (new Date(grant.expiresAt).getTime() <= Date.now())
    throw new Error("Grant expiry must be in the future");
  if (
    grant.mode !== "selected-summary" &&
    grant.allowedFields.includes("selectedSummary")
  )
    throw new Error(
      "Selected summaries require the selected-summary disclosure mode",
    );
  if (
    grant.mode !== "cloud-synthesis-selected" &&
    grant.allowedFields.includes("selectedEvidence")
  )
    throw new Error(
      "Selected evidence requires the cloud-synthesis-selected disclosure mode",
    );
  if (
    grant.mode === "selected-summary" &&
    !grant.allowedFields.includes("selectedSummary")
  )
    throw new Error(
      "The selected-summary mode requires an inspected selectedSummary field",
    );
  if (
    grant.mode === "cloud-synthesis-selected" &&
    !grant.allowedFields.includes("selectedEvidence")
  )
    throw new Error(
      "Cloud synthesis requires an inspected selectedEvidence field",
    );
  return grant;
}

export { canonicalJson as __canonicalJson };
