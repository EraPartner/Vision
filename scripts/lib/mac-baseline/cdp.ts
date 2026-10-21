/**
 * Minimal Chrome DevTools Protocol client for the Mac performance baseline.
 * One browser-level socket; page work goes through flattened target sessions.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | undefined;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      this.handle(String(message.data));
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`CDP socket closed during ${pending.method}`));
      }
      this.pending.clear();
    });
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`CDP connect timed out: ${url}`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      });
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 120_000,
  ): Promise<T> {
    const id = this.nextId++;
    const message: CdpMessage = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForEvent(method: string, timeoutMs = 60_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event ${method} not seen in ${timeoutMs} ms`));
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (event.method !== method) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  private handle(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message ?? "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      };
      for (const listener of this.listeners) listener(event);
    }
  }
}

/** The browser-level socket URL, polling until the debugging endpoint answers. */
export async function browserSocketUrl(
  port: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Remote debugging endpoint on port ${port} did not answer (${lastError || "no response"}). ` +
      "The app may ignore --remote-debugging-port.",
  );
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** Attach to the first page target whose URL passes `accept`. */
export async function attachToPage(
  client: CdpClient,
  accept: (url: string) => boolean,
  timeoutMs: number,
): Promise<{ sessionId: string; url: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const page = targetInfos.find(
      (target) => target.type === "page" && accept(target.url),
    );
    if (page) {
      const { sessionId } = await client.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
      );
      return { sessionId, url: page.url };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("No application page target appeared");
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

/** Run an expression in the page and return its JSON value. */
export async function evaluate<T>(
  client: CdpClient,
  sessionId: string,
  expression: string,
  timeoutMs = 120_000,
): Promise<T> {
  const response = await client.send<EvaluateResult>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    timeoutMs,
  );
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(
      `Page evaluation failed: ${details.exception?.description ?? details.text ?? "unknown"}`,
    );
  }
  return response.result?.value as T;
}

/** Read a CDP IO stream (Tracing.end with ReturnAsStream) to a string. */
export async function readStream(
  client: CdpClient,
  handle: string,
): Promise<string> {
  const chunks: string[] = [];
  for (;;) {
    const chunk = await client.send<{
      data: string;
      eof: boolean;
      base64Encoded?: boolean;
    }>("IO.read", { handle, size: 4 * 1024 * 1024 });
    chunks.push(
      chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64").toString("utf8")
        : chunk.data,
    );
    if (chunk.eof) break;
  }
  await client.send("IO.close", { handle });
  return chunks.join("");
}
