/** Loopback-only HTTP gateway for Tailscale Funnel's PROXY protocol v2 mode. */
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");
const STRIP = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "x-moneyworry-proxy-token", "connection", "proxy-connection", "proxy-authorization",
  "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
]);

export function parseProxyV2(buffer) {
  if (buffer.length < 16) return null;
  if (!buffer.subarray(0, 12).equals(SIGNATURE) || buffer[12] !== 0x21) throw new Error("PROXY_HEADER_INVALID");
  const family = buffer[13];
  const addressBytes = family === 0x11 ? 12 : family === 0x21 ? 36 : 0;
  const payloadLength = buffer.readUInt16BE(14);
  if (!addressBytes || payloadLength < addressBytes || payloadLength > 2048) throw new Error("PROXY_FAMILY_INVALID");
  const total = 16 + payloadLength;
  if (buffer.length < total) return null;
  const ip = family === 0x11
    ? Array.from(buffer.subarray(16, 20)).join(".")
    : Array.from({ length: 8 }, (_, index) => buffer.readUInt16BE(16 + index * 2).toString(16)).join(":");
  if (!net.isIP(ip)) throw new Error("PROXY_IP_INVALID");
  return { ip, total };
}

function safeHeaders(headers) {
  const nominated = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((part) => part.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([key]) => {
    const lower = key.toLowerCase();
    return !STRIP.has(lower) && !nominated.has(lower) && !lower.startsWith("x-forwarded-");
  }));
}

export function createGateway({ port, upstreamPort, publicHost, proxyToken }) {
  if (!Number.isInteger(port) || !Number.isInteger(upstreamPort) ||
      !/^[a-z0-9.-]+$/i.test(publicHost) || proxyToken.length < 32) throw new Error("GATEWAY_CONFIG_INVALID");
  const identities = new WeakMap();
  const httpServer = http.createServer((request, response) => {
    if (request.headers.host !== publicHost) {
      console.warn(JSON.stringify({ event: "public_gateway_host_rejected" }));
      response.writeHead(421, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const ip = identities.get(request.socket);
    if (!ip) {
      console.warn(JSON.stringify({ event: "public_gateway_identity_missing" }));
      response.writeHead(403, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const headers = {
      ...safeHeaders(request.headers),
      host: publicHost,
      "x-forwarded-for": ip,
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "https",
      "x-moneyworry-proxy-token": proxyToken,
    };
    const upstream = http.request({ hostname: "127.0.0.1", port: upstreamPort,
      method: request.method, path: request.url, headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, safeHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      console.warn(JSON.stringify({ event: "public_gateway_upstream_unavailable" }));
      if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  const server = net.createServer((socket) => {
    if (!net.isIP(socket.remoteAddress ?? "") ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress)) {
      console.warn(JSON.stringify({ event: "public_gateway_peer_rejected" }));
      socket.destroy();
      return;
    }
    socket.setTimeout(5_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65_536) {
        console.warn(JSON.stringify({ event: "public_gateway_prelude_rejected" }));
        socket.destroy();
        return;
      }
      let parsed;
      try { parsed = parseProxyV2(pending); } catch {
        console.warn(JSON.stringify({ event: "public_gateway_prelude_rejected" }));
        socket.destroy();
        return;
      }
      if (!parsed) return;
      socket.off("data", onData);
      socket.setTimeout(0);
      identities.set(socket, parsed.ip);
      const remainder = pending.subarray(parsed.total);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      httpServer.emit("connection", socket);
      socket.resume();
    };
    socket.on("data", onData);
  });
  server.on("close", () => httpServer.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = createGateway({ port: Number(process.env.PUBLIC_GATEWAY_PORT ?? "3110"),
    upstreamPort: Number(process.env.PUBLIC_GATEWAY_UPSTREAM_PORT ?? "3111"),
    publicHost: process.env.PUBLIC_GATEWAY_PUBLIC_HOST ?? "",
    proxyToken: process.env.PUBLIC_RATE_LIMIT_PROXY_TOKEN ?? "" });
  gateway.listen(Number(process.env.PUBLIC_GATEWAY_PORT ?? "3110"), "127.0.0.1");
}
