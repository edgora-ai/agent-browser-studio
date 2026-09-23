// Local OpenAI-compatible fixture for streaming, tools and cancellation journeys.
import * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface MockLlmOptions {
  chunks?: string[];
  delayMs?: number;
  statusCode?: number;
  model?: string;
  /** Request N uses responses[N], repeating the last entry when exhausted. */
  responses?: MockLlmResponse[];
  /** Dynamic responder: sees the real request body and returns the next
   *  response. Outranks `responses`. */
  responder?: MockResponder;
}

/** Build a response from the actual request.
 *
 *  M2 needs this: the execution contract carries the real run_id in the
 *  system prompt, and the fixture has to write rows under THAT id. Predicting
 *  the id would test the prediction instead of the product, so the responder
 *  reads it out of the request it was actually given. Returning `null` falls
 *  back to the scripted/static response. */
export type MockResponder = (
  body: any,
  context: { index: number; systemPrompt: string; userPrompt: string },
) => MockLlmResponse | null;

export interface MockLlmResponse {
  chunks?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Hold before any response text/tools until releaseRequest(index). */
  pause?: boolean;
  /** Streaming only: emit this many chunks, then wait for releaseRequest. */
  pauseAfterChunks?: number;
  delayMs?: number;
}

export interface CapturedRequest {
  body: any;
  headers: IncomingHttpHeaders;
  receivedAt: number;
  closedAt?: number;
  closedBeforeEnd?: boolean;
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
  setResponder(responder: MockResponder | null): void;
  releaseRequest(index: number): boolean;
  close(): Promise<void>;
}

export async function startMockLlm(opts: MockLlmOptions = {}): Promise<MockLlmServer> {
  const state = {
    chunks: opts.chunks ?? ["Hello", " from", " mock", " LLM."],
    delayMs: opts.delayMs ?? 100,
    statusCode: opts.statusCode ?? 200,
    model: opts.model ?? "e2e-mock-model",
    responses: opts.responses ? [...opts.responses] : null,
    responder: opts.responder ?? null,
    requestCount: 0,
  };
  const requests: CapturedRequest[] = [];
  const controls = new Map<number, () => void>();
  let nextOverrides: Array<{ statusCode?: number; body?: string }> = [];

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        res.writeHead(400).end("Invalid fixture request JSON: " + String(error));
        return;
      }
      const index = requests.length;
      const captured: CapturedRequest = { body, headers: req.headers, receivedAt: Date.now() };
      requests.push(captured);
      let timer: ReturnType<typeof setTimeout> | undefined;
      res.on("close", () => {
        captured.closedAt = Date.now();
        captured.closedBeforeEnd = !res.writableFinished;
        if (timer) clearTimeout(timer);
        controls.delete(index);
      });
      const override = nextOverrides.shift();
      const status = override?.statusCode ?? state.statusCode;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(override?.body || JSON.stringify({ error: { message: "mock error" } }));
        return;
      }
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      const systemPrompt = String(messages.find((m) => m?.role === "system")?.content ?? "");
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const userPrompt = String(typeof lastUser?.content === "string" ? lastUser.content : "");
      let dynamic: MockLlmResponse | null = null;
      if (state.responder) {
        dynamic = state.responder(body, { index, systemPrompt, userPrompt });
      }
      const scripted = dynamic ?? (state.responses?.length
        ? state.responses[Math.min(state.requestCount, state.responses.length - 1)] : null);
      state.requestCount++;
      const textChunks = scripted?.chunks ?? state.chunks;
      const toolCalls = scripted?.toolCalls ?? [];
      const pauseAt = scripted?.pauseAfterChunks ?? (scripted?.pause ? 0 : undefined);
      let released = false;
      let waiting: (() => void) | undefined;
      controls.set(index, () => {
        released = true;
        const resume = waiting;
        waiting = undefined;
        resume?.();
      });
      const paused = (emitted: number, resume: () => void) => {
        if (pauseAt === undefined || emitted < pauseAt || released) return false;
        waiting = resume;
        return true;
      };
      const toolPayload = () => toolCalls.map((call) => ({ id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));

      if (!body.stream) {
        const respond = () => {
          if (res.destroyed || res.writableEnded || paused(0, respond)) return;
          const message: any = { role: "assistant", content: textChunks.join("") };
          if (toolCalls.length) message.tool_calls = toolPayload();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `mock-${index}`, object: "chat.completion", model: state.model,
            choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] }));
        };
        respond();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      const write = (delta: any) => res.write(`data: ${JSON.stringify({ id: `mock-${index}`, object: "chat.completion.chunk", model: state.model,
        choices: [{ index: 0, delta }] })}\n\n`);
      write({ role: "assistant" });
      let emitted = 0;
      const sendNext = () => {
        timer = undefined;
        if (res.destroyed || res.writableEnded || paused(emitted, sendNext)) return;
        if (emitted < textChunks.length) {
          write({ content: textChunks[emitted++] });
          timer = setTimeout(sendNext, scripted?.delayMs ?? state.delayMs);
          return;
        }
        if (toolCalls.length) write({ tool_calls: toolPayload().map((call, index) => ({ index, ...call })) });
        res.end("data: [DONE]\n\n");
      };
      timer = setTimeout(sendNext, scripted?.delayMs ?? state.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock llm failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/v1/chat/completions`, origin, port: address.port, model: state.model, requests,
    setChunks(chunks) { state.chunks = chunks; },
    setNextResponse(override) { nextOverrides.push(override); },
    setNextResponses(overrides) { nextOverrides.push(...overrides); },
    setResponses(responses) { state.responses = [...responses]; state.requestCount = 0; },
    setResponder(responder) { state.responder = responder; },
    releaseRequest(index) {
      const release = controls.get(index);
      if (!release) return false;
      release();
      return true;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
