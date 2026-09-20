import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  __parseCodexConnectHeader as parseConnectHeader,
  startCodexConnectProxy,
} from "../src/integrations/codex/connectProxy.js";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function send(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

function sendTunnel(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    let sent = false;
    socket.on("connect", () =>
      socket.write(
        "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n",
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("200 Connection Established") && !sent) {
        sent = true;
        socket.write("synthetic");
      }
      if (response.includes("echo:synthetic")) socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

describe("Codex CONNECT egress proxy", () => {
  it("rejects methods, destinations, credentials, and ambiguous hosts", () => {
    const allow = new Set(["chatgpt.com"]);
    expect(
      parseConnectHeader(
        "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443",
        allow,
      ),
    ).toBe("chatgpt.com");
    for (const header of [
      "GET https://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com",
      "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443",
      "CONNECT chatgpt.com:80 HTTP/1.1\r\nHost: chatgpt.com:80",
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nHost: evil.example",
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic fake",
    ]) {
      expect(parseConnectHeader(header, allow)).toBeUndefined();
    }
  });

  it("forwards only the allowed hostname and records bounded metadata", async () => {
    const upstream = createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
    const destinations = [];
    const traces = [];
    const proxy = await startCodexConnectProxy({
      allowedHosts: new Set(["chatgpt.com"]),
      connectUpstream: ({ host, port }) => {
        destinations.push({ host, port });
        return connect({ host: "127.0.0.1", port: upstream.address().port });
      },
      onTrace: (trace) => traces.push(trace),
    });
    cleanup.push(() => proxy.close());
    expect(
      await send(
        proxy.port,
        "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
      ),
    ).toMatch(/^HTTP\/1\.1 403/);
    expect(destinations).toEqual([]);
    const result = await sendTunnel(proxy.port);
    expect(result).toContain("200 Connection Established");
    expect(result).toContain("echo:synthetic");
    expect(destinations).toEqual([{ host: "chatgpt.com", port: 443 }]);
    expect(traces).toEqual([expect.objectContaining({ host: "chatgpt.com" })]);
  });
});
