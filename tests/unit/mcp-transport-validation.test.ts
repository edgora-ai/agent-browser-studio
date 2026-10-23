import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixture, request, rawRequest } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
const unhandled: unknown[] = [];
const observeUnhandled = (error: unknown) => unhandled.push(error);
beforeAll(async () => { process.on("unhandledRejection", observeUnhandled); f = await startFixture("mcp"); });
afterAll(async () => {
  await f?.close(); process.off("unhandledRejection", observeUnhandled);
  expect(unhandled).toEqual([]);
});

async function probe() {
  const good = await f.rpc("initialize");
  expect(good.status).toBe(200);
  expect(good.body.result.serverInfo.name).toBe("agent-browser-studio");
}

describe("MCP actual socket trust and published endpoint compatibility", () => {
  it("keeps health public and both RPC entrypoints protected without query-token auth", async () => {
    expect((await request(f.mcpPort, "/health")).status).toBe(200);
    for (const route of ["/mcp", "/", "/sse", "/mcp?token=" + f.mcp!.getMcpToken()]) {
      expect((await request(f.mcpPort, route, { method: "POST", body: {} })).status).toBe(401);
    }
    expect((await request(f.mcpPort, "/mcp", { body: { jsonrpc: "2.0", id: "auth", method: "initialize" }, headers: { "X-Cloak-Token": f.mcp!.getMcpToken() } })).status).toBe(200);
  });
  it("rejects foreign and malformed Origin before dispatch but allows loopback Origin and preflight", async () => {
    for (const origin of ["https://foreign.invalid", "null", "garbage", "file:///"]) {
      expect((await request(f.mcpPort, "/health", { headers: { Origin: origin } })).status).toBe(403);
    }
    expect((await request(f.mcpPort, "/health", { headers: { Origin: "http://localhost:1234" } })).status).toBe(200);
    expect((await request(f.mcpPort, "/mcp", { method: "OPTIONS" })).status).toBe(204);
  });
  it("retains root's initialize-only compatibility instead of inventing a new RPC endpoint", async () => {
    expect((await f.rpc("initialize", undefined, "/")).body.result.protocolVersion).toBe("2024-11-05");
    expect((await f.rpc("tools/list", undefined, "/")).status).toBe(404);
    expect((await request(f.mcpPort, "/", { token: f.mcp!.getMcpToken() })).status).toBe(404);
    expect((await request(f.mcpPort, "/mcp", { token: f.mcp!.getMcpToken() })).status).toBe(404);
  });
});

describe("MCP malformed payloads are contained, never listener promise rejections", () => {
  for (const route of ["/mcp", "/"]) {
    it.each(["{", "{\"id\":1,}"])(`${route}: malformed JSON %j reports parse error and the next request succeeds`, async raw => {
      const bad = await request(f.mcpPort, route, { token: f.mcp!.getMcpToken(), raw });
      expect(bad.status).toBe(400); expect(bad.body.error.code).toBe(-32700);
      await probe();
    });
    it.each([null, [], [1], true, 7, "payload"].map(body => [body]))(`${route}: rejects non-object JSON %j and remains usable`, async body => {
      try {
        const bad = await request(f.mcpPort, route, { token: f.mcp!.getMcpToken(), body }).catch(error => ({ status: 0, body: { error } }));
        expect(bad.status).toBe(400); expect(bad.body.error.code).toBe(-32600);
      } finally { await probe(); }
    });
  }
  it.each([
    {}, { jsonrpc: "1.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", id: {}, method: "initialize" },
    { jsonrpc: "2.0", id: 1, method: null }, { jsonrpc: "2.0", id: 1, method: 7 }, { jsonrpc: "2.0", id: 1, method: "" },
  ])("rejects invalid request envelope %j", async body => {
    const bad = await request(f.mcpPort, "/mcp", { token: f.mcp!.getMcpToken(), body });
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe(-32600);
    await probe();
  });
  it.each([
    { method: "initialize", params: null }, { method: "tools/list", params: [] },
    { method: "tools/call", params: 1 }, { method: "tools/call" },
    { method: "tools/call", params: { name: null } }, { method: "tools/call", params: { name: 7 } },
    { method: "tools/call", params: { name: "" } },
    { method: "tools/call", params: { name: "agent_browser_list_profiles", arguments: [] } },
    { method: "tools/call", params: { name: "agent_browser_list_profiles", arguments: "args" } },
    { method: "tools/call", params: { name: "agent_browser_list_profiles", arguments: null } },
  ])("rejects invalid MCP method params %j before tool dispatch", async fields => {
    const bad = await request(f.mcpPort, "/mcp", { token: f.mcp!.getMcpToken(), body: { jsonrpc: "2.0", id: "invalid-params", ...fields } });
    expect(bad.status).toBe(400); expect(bad.body.id).toBe("invalid-params"); expect(bad.body.error.code).toBe(-32602);
    await probe();
  });
  it("retains method-not-found protocol errors for well-formed unknown methods", async () => {
    const bad = await f.rpc("unimplemented/method");
    expect(bad.status).toBe(200); expect(bad.body.error.code).toBe(-32601);
    await probe();
  });
  it.each(["/mcp", "/"])("%s contains declared oversized bodies without an unhandled rejection", async route => {
    const response = await rawRequest(f.mcpPort, `POST ${route} HTTP/1.1\r\nHost: 127.0.0.1:${f.mcpPort}\r\nAuthorization: Bearer ${f.mcp!.getMcpToken()}\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\nx`);
    try { expect(response).toMatch(/^HTTP\/1\.1 413 /); } finally { await probe(); }
  });
  it("contains a chunked streaming size breach, then serves a legitimate request", async () => {
    const chunk = JSON.stringify({ jsonrpc: "2.0", id: "oversized-valid-json", method: "initialize", params: { padding: "x".repeat(1048577) } });
    const response = await rawRequest(f.mcpPort, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${f.mcpPort}\r\nAuthorization: Bearer ${f.mcp!.getMcpToken()}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n0\r\n\r\n`);
    // Destroyed streaming requests may have no writable response socket. An
    // accepted 200/202, or a JSON parse error on this valid JSON, is not a cap.
    expect(response === "" || /^HTTP\/1\.1 413 /.test(response)).toBe(true);
    await probe(); expect(unhandled).toEqual([]);
  });
  it("contains a disconnected partial body, then serves a legitimate request", async () => {
    await rawRequest(f.mcpPort, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${f.mcpPort}\r\nAuthorization: Bearer ${f.mcp!.getMcpToken()}\r\nContent-Length: 400\r\n\r\n{`, true);
    await probe(); expect(unhandled).toEqual([]);
  });
});
