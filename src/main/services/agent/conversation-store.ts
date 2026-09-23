import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAppDataDir } from "../config-manager.js";
import type { AgentRunEndReason, AgentRunVerification } from "../../types.js";

export interface ConversationMessage {
  role: string;
  content: string;
  toolResults?: any[];
  timestamp?: number;
  runId?: string;
  requestId?: string;
  endReason?: AgentRunEndReason;
  verification?: AgentRunVerification;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export function conversationsPath(): string {
  return path.join(getAppDataDir(), "agent-conversations.json");
}

/** Read the raw history file.
 *
 *  - A genuinely missing file (first run) is an empty history.
 *  - Every other failure (EIO, EACCES, EMFILE, …) is a *read* failure and must
 *    propagate: every writer here is load → mutate → save, so returning [] on a
 *    transient error would persist the empty list over the real conversations.
 */
function readHistoryRaw(): string | null {
  const p = conversationsPath();
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    const code = e?.code ? String(e.code) : "unknown error";
    throw new Error(
      `Failed to read the conversation history at ${p} (${code}: ${e?.message || String(e)}). ` +
      `Refusing to continue so existing conversations are not overwritten.`,
      { cause: e },
    );
  }
}

/** Unique salvage path. Never a fixed name — two failures in the same
 *  millisecond must not overwrite each other's evidence. */
function nextBackupPath(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.${stamp}.${randomUUID()}.corrupt`;
}

/** The stored file exists but cannot be parsed as a conversation list. The
 *  original is copied aside for salvage and left in place — it is NOT removed
 *  or reset, and the next read still fails rather than reporting "no history".
 *
 *  Parse errors are deliberately not echoed: Node's JSON messages quote the
 *  offending input, which would put conversation contents into the error text
 *  (and from there into logs and the UI). */
function corruptHistoryError(filePath: string, reason: string): Error {
  const backupPath = nextBackupPath(filePath);
  try {
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (backupError: any) {
    return new Error(
      `Agent conversation history at ${filePath} could not be loaded (${reason}) and the salvage backup failed ` +
      `(${backupError?.code || backupError?.message || "unknown error"}). The original file was left untouched.`,
    );
  }
  return new Error(
    `Agent conversation history at ${filePath} could not be loaded (${reason}) and was NOT overwritten. ` +
    `A salvage copy was kept at ${backupPath}. Restore or remove the original file to continue.`,
  );
}

export function loadConversations(): Conversation[] {
  const raw = readHistoryRaw();
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptHistoryError(conversationsPath(), "it is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw corruptHistoryError(conversationsPath(), "its root is not a JSON array");
  }
  return parsed as Conversation[];
}

export function saveConversations(convs: Conversation[]): void {
  const p = conversationsPath();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(convs, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (e) { console.error("Failed to restrict conversation file permissions:", e); }
}

export function createConversation(title?: string): Conversation {
  const id = "conv_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const conv: Conversation = {
    id,
    title: title || "New Chat",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const convs = loadConversations();
  convs.unshift(conv);
  saveConversations(convs);
  return conv;
}

export function getConversation(id: string): Conversation | null {
  return loadConversations().find(c => c.id === id) || null;
}

export function listConversations(): Conversation[] {
  return loadConversations().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteConversation(id: string): boolean {
  const convs = loadConversations();
  const idx = convs.findIndex(c => c.id === id);
  if (idx < 0) return false;
  convs.splice(idx, 1);
  saveConversations(convs);
  return true;
}

export function renameConversation(id: string, title: string): Conversation | null {
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.title = title;
  c.updatedAt = Date.now();
  saveConversations(convs);
  return c;
}

export function addMessage(id: string, msg: ConversationMessage): Conversation | null {
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.messages.push(msg);
  c.updatedAt = Date.now();
  saveConversations(convs);
  return c;
}

export function updateConversationMessages(id: string, messages: Conversation["messages"]): Conversation | null {
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.messages = messages;
  c.updatedAt = Date.now();
  saveConversations(convs);
  return c;
}
