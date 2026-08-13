// Mock OpenAI-compatible SSE server for J4 agent-stream test.
import * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface MockLlmOptions {
  chunks?: string[];
  delayMs?: number;
  statusCode?: number;
  model?: string;
  /** Per-request response script. If set, request N uses responses[N]; each
   *  entry can emit text chunks and/or OpenAI tool_calls (streamed). */
  responses?: MockLlmResponse[];
}

export interface MockLlmResponse {
  chunks?: string[];
  /** OpenAI tool_calls to stream back (function name + JSON args). */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface CapturedRequest {
  body: any;
  headers: IncomingHttpHeaders;
  receivedAt: number;
}

export interface MockLlmServer {
  url: string;
  origin: string;
  port: number;
  model: string;
  requests: CapturedRequest[];
  setChunks(chunks: string[]): void;
  setNextResponse(opts: { statusCode?: number; body?: string }): void;
  setNextResponses(opts: Array<{ statusCode?: number; body?: string }>): void;
  setResponses(responses: MockLlmResponse[]): void;
  close(): Promise<void>;
}

export async function startMockLlm(opts: MockLlmOptions = {}): Promise<MockLlmServer> {
  const state = {
    chunks: opts.chunks ?? ["Hello", " from", " mock", " LLM."],
    delayMs: opts.delayMs ?? 100,
    statusCode: opts.statusCode ?? 200,
    model: opts.model ?? "e2e-mock-model",
    responses: opts.responses ? [...opts.responses] : null,
    requestCount: 0,
  };

  const requests: CapturedRequest[] = [];
  let nextOverrides: Array<{ statusCode?: number; body?: string }> = [];

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_) {
        body = null;
      }
      requests.push({ body, headers: req.headers, receivedAt: Date.now() });

      const override = nextOverrides.shift() ?? null;

      if (override?.statusCode && override.statusCode !== 200) {
        res.statusCode = override.statusCode;
        res.setHeader("content-type", "application/json");
        res.end(override.body || JSON.stringify({ error: { message: "mock error" } }));
        return;
      }

      res.statusCode = 200;

      // If a scripted response exists for this request index, use it (text + tool_calls).
      const scripted = state.responses && state.responses.length > 0
        ? state.responses[Math.min(state.requestCount, state.responses.length - 1)]
        : null;
      const textChunks = scripted?.chunks ?? state.chunks;
      const scriptedToolCalls = scripted?.toolCalls ?? [];
      state.requestCount++;

      // Non-streaming request (body.stream falsy) → return a single JSON
      // chat.completion. The automation engine uses the non-streaming path
      // (agentChat → llmOpenAI), which parses choices[0].message.
      if (!body?.stream) {
        const message: any = { role: "assistant", content: (textChunks || []).join("") };
        if (scriptedToolCalls.length > 0) {
          message.tool_calls = scriptedToolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: `mock-${Date.now()}`,
          object: "chat.completion",
          model: state.model,
          choices: [{ index: 0, message, finish_reason: scriptedToolCalls.length ? "tool_calls" : "stop" }],
        }));
        return;
      }

      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.flushHeaders?.();

      const write = (data: string) => {
        res.write(data);
      };

      // First delta with role
      write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);

      let i = 0;
      const sendNext = () => {
        if (i < textChunks.length) {
          const delta = textChunks[i++];
          write(
            `data: ${JSON.stringify({
              id: `mock-${Date.now()}`,
              object: "chat.completion.chunk",
              model: state.model,
              choices: [{ index: 0, delta: { content: delta } }],
            })}\n\n`,
          );
          setTimeout(sendNext, state.delayMs);
          return;
        }
        // Stream any tool_calls for this response (OpenAI streaming format).
        if (i === textChunks.length && scriptedToolCalls.length > 0) {
          for (let t = 0; t < scriptedToolCalls.length; t++) {
            const tc = scriptedToolCalls[t];
            write(
              `data: ${JSON.stringify({
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: t,
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    }],
                  },
                }],
              })}\n\n`,
            );
          }
          i++; // advance past tool_calls so we don't re-emit
        }
        write(`data: [DONE]\n\n`);
        res.end();
      };
      setTimeout(sendNext, state.delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock llm failed to bind");
  const port = addr.port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/v1/chat/completions`;

  return {
    url,
    origin,
    port,
    model: state.model,
    requests,
    setChunks(chunks) {
      state.chunks = chunks;
    },
    setNextResponse(o) {
      nextOverrides.push(o);
    },
    setNextResponses(overrides) {
      nextOverrides.push(...overrides);
    },
    setResponses(responses) {
      state.responses = [...responses];
      state.requestCount = 0;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
