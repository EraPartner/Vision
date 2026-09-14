function exchange({
  sessionId = "session-a",
  analysisId = "analysis-a",
  sequence = 1,
  url = "https://api.openai.com/v1/responses",
  body = {},
  cancelledAtSequence,
  redirected = false,
}) {
  const serialized = JSON.stringify(body);
  return {
    sessionId,
    analysisId,
    sequence,
    ...(cancelledAtSequence == null ? {} : { cancelledAtSequence }),
    request: {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(serialized).toString("base64"),
      byteLength: Buffer.byteLength(serialized),
    },
    response: { status: 200, redirected, url },
  };
}

const safePlan = {
  model: "synthetic-model",
  input: {
    purpose: "draft-analysis-plan",
    question: "Compare monthly category totals",
    schema: ["month", "category", "amount"],
  },
  store: false,
};

export const CLOUD_PRIVACY_EVALUATION_CASES = Object.freeze([
  {
    id: "local-only-no-egress",
    trace: { mode: "local-only", exchanges: [], telemetry: [] },
    expectedViolationCodes: [],
  },
  {
    id: "approved-cloud-plan",
    trace: {
      mode: "cloud-plan",
      exchanges: [exchange({ body: safePlan })],
      telemetry: [
        { sessionId: "session-a", event: "request-complete", status: 200 },
      ],
    },
    expectedViolationCodes: [],
  },
  {
    id: "direct-identifiers-and-values",
    trace: {
      mode: "approved-summary",
      exchanges: [
        exchange({
          body: {
            ...safePlan,
            accountId: "PRIVATE_ACCOUNT_441",
            rawTransactions: [{ recipient: "Rare Clinic", amount: -184.73 }],
          },
        }),
      ],
    },
    expectedViolationCodes: ["FORBIDDEN_FIELD", "FORBIDDEN_LITERAL"],
  },
  {
    id: "arbitrary-destination-and-query",
    trace: {
      mode: "cloud-plan",
      exchanges: [
        exchange({
          url: "https://attacker.invalid/collect?account=PRIVATE_ACCOUNT_441",
          body: safePlan,
        }),
      ],
    },
    expectedViolationCodes: [
      "UNAPPROVED_DESTINATION",
      "URL_QUERY_DISCLOSURE",
      "FORBIDDEN_LITERAL",
    ],
  },
  {
    id: "redirect-and-cancellation",
    trace: {
      mode: "cloud-plan",
      exchanges: [
        exchange({ body: safePlan, redirected: true }),
        exchange({ sequence: 3, cancelledAtSequence: 2, body: safePlan }),
      ],
    },
    expectedViolationCodes: ["REDIRECT_FOLLOWED", "POST_CANCELLATION_EGRESS"],
  },
  {
    id: "cross-session-reference-reuse",
    trace: {
      mode: "approved-summary",
      exchanges: [
        exchange({
          body: {
            ...safePlan,
            subject: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
          },
        }),
        exchange({
          sessionId: "session-b",
          analysisId: "analysis-b",
          body: {
            ...safePlan,
            subject: "[[VR1:account:AAAAAAAAAAAAAAAAAAAAAAAA]]",
          },
        }),
      ],
    },
    expectedViolationCodes: ["CROSS_SCOPE_REFERENCE_REUSE"],
  },
  {
    id: "telemetry-error-leak",
    trace: {
      mode: "cloud-plan",
      exchanges: [exchange({ body: safePlan })],
      telemetry: [
        {
          sessionId: "session-a",
          event: "provider-error",
          message: "Failed for PRIVATE_ACCOUNT_441 at Rare Clinic",
        },
      ],
    },
    expectedViolationCodes: ["TELEMETRY_DISCLOSURE"],
  },
]);

export const CLOUD_PRIVACY_SYNTHETIC_POLICY = Object.freeze({
  allowedOrigins: ["https://api.openai.com"],
  forbiddenKeys: [
    "accountId",
    "account_id",
    "transactionId",
    "transaction_id",
    "rawTransactions",
    "conversationHistory",
    "localPath",
    "filename",
  ],
  forbiddenLiterals: ["PRIVATE_ACCOUNT_441", "Rare Clinic", "184.73"],
  maxCumulativeRequestBytes: 32_768,
  maxRequestsPerSession: 12,
});

export const CLOUD_UTILITY_REFERENCE = Object.freeze({
  localOnly: {
    datasets: ["transactions_analysis"],
    groupBy: ["month", "category_name"],
    metric: "sum(amount)",
  },
  cloudPlan: {
    datasets: ["transactions_analysis"],
    groupBy: ["month", "category_name"],
    metric: "sum(amount)",
  },
  approvedSummary: {
    datasets: ["transactions_analysis"],
    groupBy: ["month", "category_name"],
    metric: "sum(amount)",
  },
});
