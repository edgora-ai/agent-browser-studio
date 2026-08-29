import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import { extractToken, isAuthorized } from "../../src/main/services/http/auth.js";

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("http/auth token authorization", () => {
  const TOKEN = "a".repeat(43) + "B";

  it("accepts the exact bearer token", () => {
    expect(isAuthorized(reqWith({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });

  it("accepts the exact x-agent-browser-token header", () => {
    expect(isAuthorized(reqWith({ "x-agent-browser-token": TOKEN }), TOKEN)).toBe(true);
  });

  it("accepts the legacy x-cloak-token header", () => {
    expect(isAuthorized(reqWith({ "x-cloak-token": TOKEN }), TOKEN)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "a".repeat(42) + "C";
    expect(wrong).not.toBe(TOKEN);
    expect(isAuthorized(reqWith({ authorization: `Bearer ${wrong}` }), TOKEN)).toBe(false);
  });

  it("rejects a wrong token of a different length", () => {
    expect(isAuthorized(reqWith({ authorization: "Bearer short" }), TOKEN)).toBe(false);
  });

  it("rejects a prefix of the real token", () => {
    expect(isAuthorized(reqWith({ "x-agent-browser-token": TOKEN.slice(0, 20) }), TOKEN)).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(isAuthorized(reqWith({}), TOKEN)).toBe(false);
  });

  it("extractToken prefers bearer over headers", () => {
    const req = reqWith({ authorization: `Bearer ${TOKEN}`, "x-agent-browser-token": "other" });
    expect(extractToken(req)).toBe(TOKEN);
  });
});
