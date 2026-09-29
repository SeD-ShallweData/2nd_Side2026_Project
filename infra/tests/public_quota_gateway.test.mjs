import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { createGateway, parseProxyV2 } from "../scripts/public-quota-gateway.mjs";

function proxyHeader(ip = [203, 0, 113, 7]) {
  const header = Buffer.alloc(28);
  Buffer.from("0d0a0d0a000d0a515549540a", "hex").copy(header);
  header[12] = 0x21;
  header[13] = 0x11;
  header.writeUInt16BE(12, 14);
  Buffer.from(ip).copy(header, 16);
  Buffer.from([127, 0, 0, 1]).copy(header, 20);
  header.writeUInt16BE(443, 24);
  header.writeUInt16BE(3110, 26);
  return header;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function raw(port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("error", (error) => error.code === "ECONNRESET" ? resolve(Buffer.concat(chunks).toString()) : reject(error));
  });
}

test("parses only a complete PROXY v2 TCP source address", () => {
  const header = proxyHeader();
  assert.equal(parseProxyV2(header.subarray(0, 15)), null);
  assert.deepEqual(parseProxyV2(header), { ip: "203.0.113.7", total: 28 });
  assert.throws(() => parseProxyV2(Buffer.alloc(28)), /PROXY_HEADER_INVALID/);
});

test("strips forged forwarding/token headers and rejects direct HTTP", async () => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({ port: 0, upstreamPort, publicHost: "demo.example.test",
    proxyToken: "server-only-proxy-token-at-least-32-characters" });
  const port = await listen(gateway);
  try {
    const request = Buffer.from("GET /api/companies/search?q=x HTTP/1.1\r\nHost: demo.example.test\r\nConnection: close, X-Forged-Hop\r\nX-Forwarded-For: 198.51.100.8\r\nX-Forwarded-Port: 1234\r\nX-Forged-Hop: leaked\r\nX-MoneyWorry-Proxy-Token: forged\r\n\r\n");
    const response = await raw(port, Buffer.concat([proxyHeader(), request]));
    assert.match(response, /200 OK/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]["x-forwarded-for"], "203.0.113.7");
    assert.equal(seen[0]["x-moneyworry-proxy-token"], "server-only-proxy-token-at-least-32-characters");
    assert.equal(seen[0]["x-forwarded-proto"], "https");
    assert.equal(seen[0]["x-forwarded-port"], undefined);
    assert.equal(seen[0]["x-forged-hop"], undefined);
    const direct = await raw(port, request);
    assert.equal(direct, "");
    assert.equal(seen.length, 1);
    const wrongHost = Buffer.from("GET / HTTP/1.1\r\nHost: attacker.test\r\nConnection: close\r\n\r\n");
    assert.match(await raw(port, Buffer.concat([proxyHeader(), wrongHost])), /421 Misdirected Request/);
    assert.equal(seen.length, 1);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
