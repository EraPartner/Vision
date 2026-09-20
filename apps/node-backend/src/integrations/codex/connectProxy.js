import { createServer, connect as netConnect } from "node:net";

const MAX_HEADER_BYTES = 8192;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_CLIENTS = 4;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const ALLOWED_HOSTS = Object.freeze(
  new Set(["chatgpt.com", "auth.openai.com"]),
);

function parseConnectHeader(header, allowedHosts) {
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
/** @param {{allowedHosts?: Set<string>, connectUpstream?: typeof netConnect, onTrace?: (trace: {host: string, uploaded: number, downloaded: number}) => void}} [options] */
export async function startCodexConnectProxy({
  allowedHosts = ALLOWED_HOSTS,
  connectUpstream = netConnect,
  onTrace = () => {},
} = {}) {
  const active = new Set();
  const server = createServer((client) => {
    if (active.size >= MAX_CLIENTS) {
      client.destroy();
      return;
    }
    active.add(client);
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    let upstream;
    let connected = false;
    let uploaded = 0;
    let downloaded = 0;
    let host;
    let rejected = false;
    const reject = () => {
      if (rejected) return;
      rejected = true;
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    client.on("data", (chunk) => {
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
      upstream = connectUpstream({ host, port: 443 });
      active.add(upstream);
      upstream.setTimeout?.(30_000, () => upstream.destroy());
      upstream.once("connect", () => {
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        uploaded += initial.length;
        if (uploaded > MAX_UPLOAD_BYTES) return client.destroy();
        if (initial.length) upstream.write(initial);
        client.on("data", (bytes) => {
          uploaded += bytes.length;
          if (uploaded > MAX_UPLOAD_BYTES) {
            client.destroy();
            upstream.destroy();
          }
        });
        upstream.on("data", (bytes) => {
          downloaded += bytes.length;
          if (downloaded > MAX_DOWNLOAD_BYTES) {
            client.destroy();
            upstream.destroy();
          }
        });
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => {
        active.delete(upstream);
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    async close() {
      for (const socket of active) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const __parseCodexConnectHeader = parseConnectHeader;
