const textDecoder = new TextDecoder();

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
  return textDecoder.decode(
    Uint8Array.from(Buffer.from(exchange.request.bodyBase64 || "", "base64")),
  );
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
    const url = new URL(exchange.request.url);
    const body = decodeBody(exchange);
    const searchable = `${exchange.request.url}\n${JSON.stringify(
      exchange.request.headers,
    )}\n${body}`.toLowerCase();
    const session = sessions.get(exchange.sessionId) ?? {
      count: 0,
      bytes: 0,
      bodies: [],
    };
    session.count += 1;
    session.bytes += exchange.request.byteLength ?? bodyBytes(body).byteLength;
    session.bodies.push(body);
    sessions.set(exchange.sessionId, session);

    if (!allowedOrigins.has(url.origin)) {
      violations.push(
        violation("UNAPPROVED_DESTINATION", exchange, url.origin),
      );
    }
    if (url.search) {
      violations.push(
        violation(
          "URL_QUERY_DISCLOSURE",
          exchange,
          "Request URL contains a query string",
        ),
      );
    }
    for (const headerName of Object.keys(exchange.request.headers ?? {})) {
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
    try {
      const parsed = JSON.parse(body || "null");
      for (const keyPath of findForbiddenKeys(parsed, forbiddenKeys)) {
        violations.push(violation("FORBIDDEN_FIELD", exchange, keyPath));
      }
    } catch {
      violations.push(
        violation("UNINSPECTABLE_BODY", exchange, "Body is not JSON"),
      );
    }

    for (const token of body.match(/REF_[A-Z0-9]{8,}/g) ?? []) {
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
    inspectedBytes: exchanges.reduce(
      (byteCount, exchange) => byteCount + (exchange.request.byteLength ?? 0),
      0,
    ),
    violations,
  };
}

export function scoreCloudUtility(expected, actual) {
  const expectedText = JSON.stringify(expected);
  const actualText = JSON.stringify(actual);
  return {
    exact: expectedText === actualText,
    expectedBytes: Buffer.byteLength(expectedText),
    actualBytes: Buffer.byteLength(actualText),
  };
}
