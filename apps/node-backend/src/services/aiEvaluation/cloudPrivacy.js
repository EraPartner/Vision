const textDecoder = new TextDecoder("utf-8", { fatal: true });
const DISCLOSURE_FIELDS = new Set([
  "question",
  "publicSchema",
  "language",
  "depth",
  "constraints",
  "selectedSummary",
  "selectedEvidence",
  "citations",
]);

function headersObject(headers = {}) {
  return Object.fromEntries(new Headers(headers).entries());
}

function bodyBytes(body) {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams)
    return new TextEncoder().encode(body.toString());
  throw new TypeError(
    "Inspection fetch requires an already serialized request body",
  );
}

function decodeBody(exchange) {
  const encoded = exchange.request?.bodyBase64;
  if (typeof encoded !== "string") throw new TypeError("Missing body bytes");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new TypeError("Non-canonical body encoding");
  }
  return { text: textDecoder.decode(bytes), byteLength: bytes.length };
}

function findForbiddenKeys(value, forbiddenKeys, path = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findForbiddenKeys(entry, forbiddenKeys, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];
  const found = [];
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (forbiddenKeys.has(key)) found.push(nextPath);
    found.push(...findForbiddenKeys(entry, forbiddenKeys, nextPath));
  }
  return found;
}

function violation(code, exchange, detail) {
  return {
    code,
    sessionId: exchange?.sessionId ?? null,
    sequence: exchange?.sequence ?? null,
    detail,
  };
}

export function createInspectionFetch({ fetchImpl, onExchange }) {
  if (typeof fetchImpl !== "function")
    throw new TypeError("fetchImpl is required");
  return async function inspectionFetch(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input);
    const bytes = bodyBytes(init.body);
    const exchange = {
      request: {
        url,
        method: init.method || "GET",
        headers: headersObject(init.headers),
        bodyBase64: Buffer.from(bytes).toString("base64"),
        byteLength: bytes.byteLength,
      },
    };
    onExchange(exchange);
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    exchange.response = {
      status: response.status,
      redirected: response.redirected,
      url: response.url || url,
    };
    return response;
  };
}

export const DEFAULT_CLOUD_PRIVACY_POLICY = Object.freeze({
  allowedOrigins: ["https://api.openai.com"],
  allowedPaths: ["/v1/responses"],
  allowedMethods: ["POST"],
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
  forbiddenLiterals: [],
  maxCumulativeRequestBytes: 32_768,
  maxRequestsPerSession: 12,
  requireBrokerPolicy: true,
});

export function evaluateCloudPrivacyTrace(
  trace,
  policy = DEFAULT_CLOUD_PRIVACY_POLICY,
) {
  const exchanges = trace.exchanges ?? [];
  const violations = [];
  const forbiddenKeys = new Set(policy.forbiddenKeys ?? []);
  const forbiddenHeaderNames = new Set(
    [...forbiddenKeys].map((key) => key.toLowerCase()),
  );
  const allowedOrigins = new Set(policy.allowedOrigins ?? []);
  const allowedPaths = new Set(policy.allowedPaths ?? ["/v1/responses"]);
  const allowedMethods = new Set(policy.allowedMethods ?? ["POST"]);
  const sessions = new Map();
  const tokenOwners = new Map();

  if (trace.mode === "local-only" && exchanges.length > 0) {
    violations.push(
      violation(
        "LOCAL_ONLY_EGRESS",
        exchanges[0],
        "Local-only mode emitted traffic",
      ),
    );
  }

  for (const exchange of exchanges) {
    let url;
    try {
      url = new URL(exchange.request?.url);
    } catch {
      violations.push(
        violation("UNINSPECTABLE_URL", exchange, "Request URL is invalid"),
      );
    }
    let body = "";
    let actualByteLength = 0;
    let bodyInspectible = false;
    try {
      const decoded = decodeBody(exchange);
      body = decoded.text;
      actualByteLength = decoded.byteLength;
      bodyInspectible = true;
      if (exchange.request.byteLength !== actualByteLength) {
        violations.push(
          violation(
            "BYTE_LENGTH_MISMATCH",
            exchange,
            "Declared request length differs from captured bytes",
          ),
        );
      }
    } catch {
      violations.push(
        violation("UNINSPECTABLE_BODY", exchange, "Body bytes are invalid"),
      );
    }
    const searchable = `${exchange.request?.url}\n${JSON.stringify(
      exchange.request?.headers,
    )}\n${body}`.toLowerCase();
    const session = sessions.get(exchange.sessionId) ?? {
      count: 0,
      bytes: 0,
      bodies: [],
    };
    session.count += 1;
    session.bytes += actualByteLength;
    session.bodies.push(body);
    sessions.set(exchange.sessionId, session);

    if (url && !allowedOrigins.has(url.origin)) {
      violations.push(
        violation("UNAPPROVED_DESTINATION", exchange, url.origin),
      );
    }
    if (url && !allowedPaths.has(url.pathname)) {
      violations.push(violation("UNAPPROVED_PATH", exchange, url.pathname));
    }
    if (exchange.request?.url !== "https://api.openai.com/v1/responses") {
      violations.push(
        violation(
          "NONCANONICAL_URL",
          exchange,
          "Responses URL differs from the fixed helper URL",
        ),
      );
    }
    if (!allowedMethods.has(exchange.request?.method)) {
      violations.push(
        violation("UNAPPROVED_METHOD", exchange, exchange.request?.method),
      );
    }
    let headers;
    try {
      headers = headersObject(exchange.request?.headers);
    } catch {
      headers = {};
      violations.push(
        violation(
          "UNINSPECTABLE_HEADERS",
          exchange,
          "Request headers are invalid",
        ),
      );
    }
    if (headers["content-type"] !== "application/json") {
      violations.push(
        violation(
          "INVALID_CONTENT_TYPE",
          exchange,
          "Expected application/json",
        ),
      );
    }
    if (url?.search) {
      violations.push(
        violation(
          "URL_QUERY_DISCLOSURE",
          exchange,
          "Request URL contains a query string",
        ),
      );
    }
    for (const headerName of Object.keys(exchange.request?.headers ?? {})) {
      if (forbiddenHeaderNames.has(headerName.toLowerCase())) {
        violations.push(
          violation("FORBIDDEN_FIELD", exchange, `header.${headerName}`),
        );
      }
    }
    if (exchange.response?.redirected) {
      violations.push(
        violation("REDIRECT_FOLLOWED", exchange, exchange.response.url),
      );
    }
    if (
      exchange.cancelledAtSequence != null &&
      exchange.sequence > exchange.cancelledAtSequence
    ) {
      violations.push(
        violation(
          "POST_CANCELLATION_EGRESS",
          exchange,
          "Request followed cancellation",
        ),
      );
    }
    for (const literal of policy.forbiddenLiterals ?? []) {
      if (searchable.includes(String(literal).toLowerCase())) {
        violations.push(
          violation("FORBIDDEN_LITERAL", exchange, String(literal)),
        );
      }
    }
    if (bodyInspectible) {
      try {
        const parsed = JSON.parse(body || "null");
        for (const keyPath of findForbiddenKeys(parsed, forbiddenKeys)) {
          violations.push(violation("FORBIDDEN_FIELD", exchange, keyPath));
        }
        if (policy.requireBrokerPolicy) {
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).sort().join(",") !==
              "background,input,max_output_tokens,model,store,tools" ||
            parsed.store !== false ||
            parsed.background !== false ||
            !Array.isArray(parsed.tools) ||
            parsed.tools.length !== 0 ||
            typeof parsed.input !== "string" ||
            Buffer.byteLength(parsed.input) > 512 * 1024 ||
            typeof parsed.model !== "string" ||
            parsed.model.length < 1 ||
            parsed.model.length > 200 ||
            !Number.isInteger(parsed.max_output_tokens) ||
            parsed.max_output_tokens < 64 ||
            parsed.max_output_tokens > 32_000
          ) {
            violations.push(
              violation(
                "BROKER_POLICY_VIOLATION",
                exchange,
                "OpenAI request shape changed",
              ),
            );
          } else {
            const disclosure = JSON.parse(parsed.input);
            if (
              !disclosure ||
              typeof disclosure !== "object" ||
              Array.isArray(disclosure) ||
              ["question", "selectedSummary", "selectedEvidence"].filter(
                (field) =>
                  typeof disclosure[field] === "string" &&
                  disclosure[field].length > 0,
              ).length !== 1 ||
              typeof disclosure.publicSchema !== "string" ||
              !["en", "nl"].includes(disclosure.language) ||
              !["quick", "detailed"].includes(disclosure.depth) ||
              !Array.isArray(disclosure.citations) ||
              disclosure.citations.some(
                (citation) => typeof citation !== "string",
              ) ||
              (disclosure.constraints !== undefined &&
                (!Array.isArray(disclosure.constraints) ||
                  disclosure.constraints.some(
                    (constraint) => typeof constraint !== "string",
                  )))
            ) {
              violations.push(
                violation(
                  "DISCLOSURE_SHAPE_INVALID",
                  exchange,
                  "Nested disclosure shape changed",
                ),
              );
            }
            for (const field of Object.keys(disclosure)) {
              if (!DISCLOSURE_FIELDS.has(field))
                violations.push(
                  violation("UNAPPROVED_DISCLOSURE_FIELD", exchange, field),
                );
            }
            for (const keyPath of findForbiddenKeys(
              disclosure,
              forbiddenKeys,
              "$.input",
            )) {
              violations.push(violation("FORBIDDEN_FIELD", exchange, keyPath));
            }
          }
        }
      } catch {
        violations.push(
          violation(
            "UNINSPECTABLE_BODY",
            exchange,
            "Body or disclosure is not JSON",
          ),
        );
      }
    }

    for (const token of body.match(
      /\[\[VR1:(?:account|recipient|investment|holding|category|document|subject|amount|date):[A-Za-z0-9_-]{24}\]\]/g,
    ) ?? []) {
      const owner = tokenOwners.get(token);
      const currentOwner = `${exchange.sessionId}:${exchange.analysisId}`;
      if (owner && owner !== currentOwner) {
        violations.push(
          violation("CROSS_SCOPE_REFERENCE_REUSE", exchange, token),
        );
      } else {
        tokenOwners.set(token, currentOwner);
      }
    }
  }

  for (const [sessionId, session] of sessions) {
    if (session.count > policy.maxRequestsPerSession) {
      violations.push({
        code: "REQUEST_BUDGET_EXCEEDED",
        sessionId,
        sequence: null,
        detail: `${session.count} requests`,
      });
    }
    if (session.bytes > policy.maxCumulativeRequestBytes) {
      violations.push({
        code: "CUMULATIVE_DISCLOSURE_BUDGET_EXCEEDED",
        sessionId,
        sequence: null,
        detail: `${session.bytes} bytes`,
      });
    }
  }

  for (const event of trace.telemetry ?? []) {
    const serialized = JSON.stringify(event).toLowerCase();
    for (const literal of policy.forbiddenLiterals ?? []) {
      if (serialized.includes(String(literal).toLowerCase())) {
        violations.push({
          code: "TELEMETRY_DISCLOSURE",
          sessionId: event.sessionId ?? null,
          sequence: event.sequence ?? null,
          detail: String(literal),
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    inspectedRequests: exchanges.length,
    inspectedBytes: [...sessions.values()].reduce(
      (byteCount, session) => byteCount + session.bytes,
      0,
    ),
    violations,
  };
}
