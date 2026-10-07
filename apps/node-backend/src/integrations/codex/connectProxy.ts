import { createServer, connect as netConnect } from "node:net";
import type { AddressInfo, Socket } from "node:net";

const MAX_HEADER_BYTES = 8192;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_CLIENTS = 4;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const ALLOWED_HOSTS: ReadonlySet<string> = Object.freeze(
  new Set(["chatgpt.com", "auth.openai.com"]),
);

export interface CodexConnectTrace {
  host: string;
  uploaded: number;
  downloaded: number;
}

export interface CodexConnectProxyOptions {
  allowedHosts?: ReadonlySet<string>;
  connectUpstream?: typeof netConnect;
  onTrace?: (trace: CodexConnectTrace) => void;
}

function parseConnectHeader(
  header: string,
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  const lines = header.split("\r\n");
  const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(lines[0]);
  if (!match || !HOST.test(match[1]) || !allowedHosts.has(match[1])) {
    return undefined;
  }
  const hosts = lines.slice(1).filter((line) => /^host:/i.test(line));
  if (hosts.length !== 1 || hosts[0].toLowerCase() !== `host: ${match[1]}:443`)
    return undefined;
  if (
    lines
      .slice(1)
      .some((line) =>
        /^(proxy-authorization|transfer-encoding|content-length):/i.test(line),
      )
  )
    return undefined;
  return match[1];
}

/** Start a single-process CONNECT proxy for a Seatbelt-confined Codex child. */
export async function startCodexConnectProxy({
  allowedHosts = ALLOWED_HOSTS,
  connectUpstream = netConnect,
  onTrace = () => {},
}: CodexConnectProxyOptions = {}) {
  const active = new Set<Socket>();
  const server = createServer((client) => {
    if (active.size >= MAX_CLIENTS) {
      client.destroy();
      return;
    }
    active.add(client);
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    let upstream: Socket | undefined;
    let connected = false;
    let uploaded = 0;
    let downloaded = 0;
    let host: string | undefined;
    let rejected = false;
    const reject = () => {
      if (rejected) return;
      rejected = true;
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    client.on("data", (chunk: Buffer) => {
      if (connected || rejected) return;
      header = Buffer.concat([header, Buffer.from(chunk)]);
      if (header.length > MAX_HEADER_BYTES) return reject();
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      host = parseConnectHeader(
        header.subarray(0, end).toString("ascii"),
        allowedHosts,
      );
      if (!host) return reject();
      const initial = header.subarray(end + 4);
      client.pause();
      const socket = connectUpstream({ host, port: 443 });
      upstream = socket;
      active.add(socket);
      socket.setTimeout?.(30_000, () => socket.destroy());
      socket.once("connect", () => {
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        uploaded += initial.length;
        if (uploaded > MAX_UPLOAD_BYTES) return client.destroy();
        if (initial.length) socket.write(initial);
        client.on("data", (bytes: Buffer) => {
          uploaded += bytes.length;
          if (uploaded > MAX_UPLOAD_BYTES) {
            client.destroy();
            socket.destroy();
          }
        });
        socket.on("data", (bytes: Buffer) => {
          downloaded += bytes.length;
          if (downloaded > MAX_DOWNLOAD_BYTES) {
            client.destroy();
            socket.destroy();
          }
        });
        client.pipe(socket);
        socket.pipe(client);
        client.resume();
      });
      socket.once("error", () => client.destroy());
      socket.once("close", () => {
        active.delete(socket);
        client.destroy();
      });
    });
    client.once("close", () => {
      active.delete(client);
      upstream?.destroy();
      if (host) {
        try {
          onTrace({ host, uploaded, downloaded });
        } catch {
          /* tracing must not affect isolation */
        }
      }
    });
    client.once("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const socket of active) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const __parseCodexConnectHeader = parseConnectHeader;
