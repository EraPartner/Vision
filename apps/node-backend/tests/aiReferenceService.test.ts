import { describe, expect, it } from "vitest";
import {
  mappingKey,
  prepareReferencePreview,
  restoreAnswerForJob,
  validateReferenceRequest,
} from "../src/services/aiReferenceService.ts";
import type {
  AiAnswer,
  AiInvestigationRequest,
} from "@vision/types/aiResearch";
import type {
  AiReferenceScope,
  createScope,
} from "../src/repositories/aiReferenceRepository.ts";
import { loose, partial } from "./helpers/partial.ts";

type PersistedScope = Parameters<typeof createScope>[0];

/**
 * The service reads expiresAt through new Date(), so an ISO string stands in
 * for the row's Date.
 */
const storedScope = (value: {
  id: string;
  jobId?: string | null;
  expiresAt: string;
  entries: unknown[];
}) => loose<AiReferenceScope>(value);

/** prepareReferencePreview ignores what createScope returns. */
const scopeWriter = (fn: (scope: PersistedScope) => Promise<void>) =>
  loose<typeof createScope>(fn);

const request = (value: Partial<AiInvestigationRequest>) =>
  partial<AiInvestigationRequest>(value);

const KEY = Buffer.alloc(32, 7);
const SCOPE_ID = "11111111-1111-4111-8111-111111111111";

function randomFactory() {
  let counter = 1;
  return (length: number) => Buffer.alloc(length, counter++);
}

function answer(text: string, evidenceId = "selected-evidence"): AiAnswer {
  return {
    schemaVersion: 1,
    status: "complete",
    depth: "quick",
    language: "en",
    summary: text,
    facts: [{ text, evidenceIds: [evidenceId] }],
    calculations: [{ text, evidenceIds: [evidenceId] }],
    interpretations: [{ text, evidenceIds: [evidenceId] }],
    assumptions: [text],
    missingInformation: [text],
    conflicts: [{ description: text, evidenceIds: [evidenceId, "other"] }],
    evidence: [
      {
        id: evidenceId,
        kind: "calculation",
        label: "Stable structural label",
        sourceDate: null,
        locator: "stable:locator",
        excerpt: text,
        available: true,
      },
    ],
    analysisReference: null,
  };
}

describe("scoped reversible references", () => {
  it("accepts only a canonical 32-byte base64 mapping key", () => {
    const encoded = KEY.toString("base64");
    expect(mappingKey(encoded)).toEqual(KEY);
    expect(mappingKey(`${encoded}!`)).toBeNull();
    expect(mappingKey(encoded.slice(0, -1))).toBeNull();
  });

  it("tokenizes typed values for preview and restores only display text", async () => {
    let persisted: PersistedScope | undefined;
    const prepared = await prepareReferencePreview(
      request({
        selectedSummary:
          "Compare [[vision-ref:recipient|<img src=x onerror=alert(1)>]] with [[vision-ref:recipient|<img src=x onerror=alert(1)>]].",
        selectedEvidence: null,
        referenceScopeId: null,
      }),
      {
        key: KEY,
        random: randomFactory(),
        createId: () => SCOPE_ID,
        cleanup: async () => 0,
        createScope: scopeWriter(async (scope) => {
          persisted = scope;
        }),
      },
    );
    expect(prepared.scope).toMatchObject({ id: SCOPE_ID, count: 1 });
    expect(prepared.request.selectedSummary).not.toContain("<img");
    const token = persisted!.entries[0].token;
    expect(prepared.request.selectedSummary!.match(/\[\[VR1:/g)).toHaveLength(
      2,
    );
    expect(persisted!.entries[0].ciphertext.toString("utf8")).not.toContain(
      "<img",
    );

    const restored = await restoreAnswerForJob(
      "job-1",
      answer(`Result for ${token}`),
      {
        key: KEY,
        getScope: async () =>
          storedScope({
            id: SCOPE_ID,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            entries: persisted!.entries,
          }),
      },
    );
    expect(restored.summary).toContain("<img src=x onerror=alert(1)>");
    expect(restored.facts[0].text).toContain("<img");
    expect(restored.evidence[0].excerpt).toContain("<img");
    expect(restored.evidence[0].id).toBe("selected-evidence");
    expect(restored.evidence[0].label).toBe("Stable structural label");
    expect(restored.evidence[0].locator).toBe("stable:locator");
  });

  it("protects Desktop findings in the preview and reveals them from the encrypted scope", async () => {
    let persisted: PersistedScope | undefined;
    const detected: string[] = [];
    const prepared = await prepareReferencePreview(
      request({
        selectedSummary: "Pay Alice Johnson from the local account.",
        selectedEvidence: "Evidence for Alice Johnson.",
        referenceScopeId: null,
      }),
      {
        key: KEY,
        random: randomFactory(),
        createId: () => SCOPE_ID,
        cleanup: async () => 0,
        createScope: scopeWriter(async (scope) => {
          persisted = scope;
        }),
        detectSensitiveSpans: async (text: string) => {
          detected.push(text);
          const start = text.indexOf("Alice Johnson");
          return start < 0
            ? []
            : [
                {
                  start,
                  end: start + 13,
                  text: "Alice Johnson",
                  label: "GIVEN_NAME",
                },
              ];
        },
      },
    );
    expect(detected).toHaveLength(2);
    expect(prepared.scope).toMatchObject({ id: SCOPE_ID, count: 1 });
    expect(prepared.request.selectedSummary).not.toContain("Alice Johnson");
    expect(prepared.request.selectedEvidence).not.toContain("Alice Johnson");
    const token = persisted!.entries[0].token;
    expect(prepared.request.selectedSummary).toContain(token);
    expect(prepared.request.selectedEvidence).toContain(token);
    expect(persisted!.entries[0].ciphertext.toString("utf8")).not.toContain(
      "Alice Johnson",
    );
    const restored = await restoreAnswerForJob(
      "job-1",
      answer(`Pay ${token}`),
      {
        key: KEY,
        getScope: async () =>
          storedScope({
            id: SCOPE_ID,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            entries: persisted!.entries,
          }),
      },
    );
    expect(restored.summary).toBe("Pay Alice Johnson");
  });

  it("fails closed when Desktop needs a missing key or reports invalid offsets", async () => {
    const pending = request({
      selectedSummary: "Pay Alice Johnson",
      selectedEvidence: null,
    });
    const detection = async () => [
      { start: 4, end: 17, text: "Alice Johnson", label: "GIVEN_NAME" },
    ];
    await expect(
      prepareReferencePreview(pending, {
        key: null,
        detectSensitiveSpans: detection,
        createScope: scopeWriter(async () => {
          throw new Error("should not persist");
        }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_KEY_UNAVAILABLE" });
    await expect(
      prepareReferencePreview(pending, {
        key: KEY,
        detectSensitiveSpans: async () => [
          { start: 5, end: 17, text: "Alice Johnson", label: "GIVEN_NAME" },
        ],
        createScope: scopeWriter(async () => {
          throw new Error("should not persist");
        }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_DETECTION_INVALID" });
  });

  it("rejects malformed markers before a scope is persisted", async () => {
    await expect(
      prepareReferencePreview(
        request({
          selectedSummary: "[[vision-ref:recipient missing separator]]",
          selectedEvidence: null,
        }),
        {
          key: KEY,
          random: randomFactory(),
          createId: () => SCOPE_ID,
          cleanup: async () => 0,
          createScope: scopeWriter(async () => {}),
        },
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_MARKER_MALFORMED" });
  });

  it("fails closed on token collision", async () => {
    await expect(
      prepareReferencePreview(
        request({
          selectedSummary: "[[vision-ref:account|Daily account]]",
          selectedEvidence: null,
        }),
        {
          key: KEY,
          random: randomFactory(),
          createId: () => SCOPE_ID,
          cleanup: async () => 0,
          createScope: scopeWriter(async () => {
            throw Object.assign(new Error("unique"), { code: "23505" });
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_TOKEN_COLLISION" });
  });

  it("rejects raw markers, unknown tokens, and cross-scope tokens on creation", async () => {
    await expect(
      validateReferenceRequest({
        referenceScopeId: null,
        selectedSummary: "[[vision-ref:account|Private]]",
        selectedEvidence: null,
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_PREVIEW_REQUIRED" });

    await expect(
      validateReferenceRequest({
        referenceScopeId: null,
        selectedSummary: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
        selectedEvidence: null,
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });

    await expect(
      validateReferenceRequest(
        {
          referenceScopeId: SCOPE_ID,
          selectedSummary: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
          selectedEvidence: null,
        },
        async () =>
          storedScope({
            id: SCOPE_ID,
            jobId: null,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            entries: [
              {
                token: "[[VR1:account:BBBBBBBBBBBBBBBBBBBBBBBB]]",
                referenceType: "account",
              },
            ],
          }),
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_MISMATCH" });
  });

  it("fails visibly for expired, undecryptable, and fabricated response tokens", async () => {
    await expect(
      restoreAnswerForJob(
        "job-without-scope",
        answer("[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]"),
        { key: KEY, getScope: async () => null },
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_RESTORE_REJECTED" });
    await expect(
      restoreAnswerForJob(
        "job-without-scope",
        answer("[[vr1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]"),
        { key: KEY, getScope: async () => null },
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_RESTORE_REJECTED" });

    await expect(
      restoreAnswerForJob("job-1", answer("No token"), {
        key: KEY,
        getScope: async () =>
          storedScope({
            id: SCOPE_ID,
            expiresAt: new Date(Date.now() - 1).toISOString(),
            entries: [],
          }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_SCOPE_EXPIRED" });

    let persisted: PersistedScope | undefined;
    const prepared = await prepareReferencePreview(
      request({
        selectedSummary: "[[vision-ref:account|Private account]]",
        selectedEvidence: null,
      }),
      {
        key: KEY,
        random: randomFactory(),
        createId: () => SCOPE_ID,
        cleanup: async () => 0,
        createScope: scopeWriter(async (scope) => {
          persisted = scope;
        }),
      },
    );
    await expect(
      restoreAnswerForJob("job-1", answer(prepared.request.selectedSummary!), {
        key: Buffer.alloc(32, 8),
        getScope: async () =>
          storedScope({
            id: SCOPE_ID,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            entries: persisted!.entries,
          }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_KEY_MISMATCH" });

    await expect(
      restoreAnswerForJob(
        "job-1",
        answer("[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]"),
        {
          key: KEY,
          getScope: async () =>
            storedScope({
              id: SCOPE_ID,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              entries: [],
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "REFERENCE_RESTORE_REJECTED" });
  });

  it("rejects reference tokens in non-display response structure", async () => {
    const token = "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]";
    const response = answer("Safe display text");
    response.evidence[0].label = token;
    await expect(
      restoreAnswerForJob("job-without-scope", response, {
        key: KEY,
        getScope: async () => null,
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_RESTORE_REJECTED" });
  });
});
