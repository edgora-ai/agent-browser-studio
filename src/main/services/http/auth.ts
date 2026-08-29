import type { IncomingMessage } from "node:http";
import { safeEqual } from "./body.js";

export function extractToken(req: IncomingMessage): string | null {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  const h = req.headers["x-agent-browser-token"] ?? req.headers["x-cloak-token"];
  const t = bearer || (Array.isArray(h) ? h[0] : h as string | undefined) || null;
  return t || null;
}
export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  // Constant-time compare: loopback-only does not mean timing-attack-free
  // (local processes and browsers with CSRF-grade tricks can measure).
  const token = extractToken(req);
  return token !== null && safeEqual(token, expected);
}
