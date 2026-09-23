import { afterEach, describe, expect, it } from "vitest";
import { startMockLlm, type MockLlmServer } from "../e2e/helpers/mock-llm.js";

let mock: MockLlmServer | undefined;
afterEach(async () => { if (mock) await mock.close(); mock = undefined; });

describe("controllable local LLM fixture", () => {
  it("holds a JSON completion until explicitly released", async () => {
    mock = await startMockLlm({ responses: [{ chunks: ["released"], pause: true }] });
    let finished = false;
    const response = fetch(mock.url, { method: "POST", body: JSON.stringify({ messages: [], stream: false }) })
      .then((response) => response.json()).then((body) => { finished = true; return body as any; });
    await expect.poll(() => mock!.requests.length).toBe(1);
    expect(finished).toBe(false);
    expect(mock.releaseRequest(0)).toBe(true);
    expect((await response).choices[0].message.content).toBe("released");
    await expect.poll(() => mock!.requests[0].closedBeforeEnd).toBe(false);
  });

  it("observes a real disconnect while a streamed response is held", async () => {
    mock = await startMockLlm({ delayMs: 1, responses: [{ chunks: ["partial", "must not arrive"], pauseAfterChunks: 1 }] });
    const controller = new AbortController();
    const response = await fetch(mock.url, { method: "POST", body: JSON.stringify({ stream: true }), signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("partial")) body += decoder.decode((await reader.read()).value);
    const remainder = reader.read();
    controller.abort();
    await expect(remainder).rejects.toThrow();
    await expect.poll(() => mock!.requests[0].closedBeforeEnd).toBe(true);
    expect(body).not.toContain("must not arrive");
    expect(mock.releaseRequest(0)).toBe(false);
  });

  it("does not release or abort another concurrent request", async () => {
    mock = await startMockLlm({ delayMs: 1, responses: [{ chunks: ["held"], pause: true }, { chunks: ["independent"] }] });
    const controller = new AbortController();
    const held = fetch(mock.url, { method: "POST", body: JSON.stringify({ stream: false }), signal: controller.signal });
    const rejected = expect(held).rejects.toThrow();
    await expect.poll(() => mock!.requests.length).toBe(1);
    const other = await fetch(mock.url, { method: "POST", body: JSON.stringify({ stream: true }) });
    expect(await other.text()).toContain("independent");
    controller.abort();
    await rejected;
    await expect.poll(() => mock!.requests[0].closedBeforeEnd).toBe(true);
    expect(mock.requests[1].closedBeforeEnd).toBe(false);
  });
});
