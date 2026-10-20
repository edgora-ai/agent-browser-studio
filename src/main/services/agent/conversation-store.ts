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
  titleKind?: "default" | "literal" | null;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export function conversationsPath(): string {
  return path.join(getAppDataDir(), "agent-conversations.json");
}

const DEFAULT_TITLE = "New Chat";

/** Only a consistent positive marker authorizes automatic title replacement.
 * Older binaries can leave stale provenance; reads must not repair or guess it. */
function hasDefaultTitle(c: Conversation): boolean {
  return c.titleKind === "default" && c.title === DEFAULT_TITLE;
}

/** JSON may contain future/opaque provenance. Preserve it in the raw store, but
 * never expose arbitrary values (especially objects) as the public enum. */
function conversationDto(c: Conversation): Conversation {
  const { titleKind, ...rest } = c;
  if (titleKind === null || titleKind === "literal" || hasDefaultTitle(c)) {
    return { ...rest, titleKind };
  }
  return rest;
}

function assertConversationId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Conversation ID must be nonblank text. Original history was not changed.");
  }
}

/** Any unusable or duplicate identity blocks the entire history, including
 * mutations of otherwise valid rows. IDs are never repaired, trimmed or
 * regenerated: existing nonblank legacy strings remain exact identities. */
function assertUniqueIds(convs: Conversation[]): void {
  if (!Array.isArray(convs)) throw new Error("Conversation history must be a list. Original history was not changed.");
  const ids = new Set<string>();
  for (const c of convs) {
    assertConversationId(c?.id);
    if (ids.has(c.id)) throw new Error("Ambiguous conversation history: duplicate IDs. Original history was not changed.");
    ids.add(c.id);
  }
}

/** Filesystem messages/causes may contain private input. Expose only a known
 * errno, never the original message, arbitrary value or nested cause. */
const IO_CODES = new Set([
  "EACCES", "EBADF", "EBUSY", "EEXIST", "EFBIG", "EINTR", "EINVAL", "EIO",
  "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOMEM",
  "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "EXDEV",
]);
function safeIoCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && IO_CODES.has(code) ? code : "UNKNOWN";
  } catch {
    // A getter/proxy may throw private content while extracting the code itself.
    return "UNKNOWN";
  }
}

function ioError(operation: string, code: string): Error {
  return new Error(`Failed to ${operation} the conversation history (${code}). Existing committed history was not overwritten.`, {
    cause: Object.assign(new Error("Conversation history filesystem failure"), { code }),
  });
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
  } catch (e: unknown) {
    const code = safeIoCode(e);
    if (code === "ENOENT") return null;
    throw ioError("read", code);
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
    fs.chmodSync(backupPath, 0o600);
  } catch (backupError: unknown) {
    return new Error(
      `Agent conversation history at ${filePath} could not be loaded (${reason}) and the salvage backup failed ` +
      `(${safeIoCode(backupError)}). The original file was left untouched.`,
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
  const convs = parsed as Conversation[];
  assertUniqueIds(convs);
  return convs;
}

/** A raw replacement/clear is not permission to repair invalid committed IDs.
 * Apply the same whole-history rejection policy as every load/mutate writer. */
export function saveConversations(convs: Conversation[]): void {
  assertUniqueIds(convs);
  loadConversations();
  persistConversations(convs);
}

/** Internal writers already loaded and validated the committed history. Keep
 * their message/title transition at one load and one atomic replacement. */
function persistConversations(convs: Conversation[]): void {
  assertUniqueIds(convs);
  const p = conversationsPath();
  const tmp = p + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(convs, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) {
    throw ioError("save", safeIoCode(e));
  }
  try { fs.chmodSync(p, 0o600); } catch { console.error("Failed to restrict conversation file permissions."); }
}

export function createConversation(title?: string): Conversation {
  if (title !== undefined && typeof title !== "string") throw new Error("Conversation title must be text.");
  const convs = loadConversations();
  const id = "conv_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  if (convs.some(c => c.id === id)) throw new Error("Conversation ID collision. Existing history was not changed.");
  const isDefault = title === undefined || title.trim().length === 0;
  const conv: Conversation = {
    id,
    title: isDefault ? DEFAULT_TITLE : title!,
    titleKind: isDefault ? "default" : "literal",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  convs.unshift(conv);
  persistConversations(convs);
  return conversationDto(conv);
}

export function getConversation(id: string): Conversation | null {
  assertConversationId(id);
  const c = loadConversations().find(c => c.id === id);
  return c ? conversationDto(c) : null;
}

export function listConversations(): Conversation[] {
  return loadConversations().sort((a, b) => b.updatedAt - a.updatedAt).map(conversationDto);
}

export function deleteConversation(id: string): boolean {
  assertConversationId(id);
  const convs = loadConversations();
  const idx = convs.findIndex(c => c.id === id);
  if (idx < 0) return false;
  convs.splice(idx, 1);
  persistConversations(convs);
  return true;
}

export function renameConversation(id: string, title: string): Conversation | null {
  assertConversationId(id);
  if (typeof title !== "string" || title.trim().length === 0) throw new Error("Conversation title must be nonblank text.");
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.title = title;
  c.titleKind = "literal";
  c.updatedAt = Date.now();
  persistConversations(convs);
  return conversationDto(c);
}

/** The service opts into auto-title here so the message and provenance transition
 * share a single synchronous unique-target load/mutate/save. Raw-store callers
 * retain their existing append-only behavior by default. */
export function addMessage(id: string, msg: ConversationMessage, autoTitleFromUser = false): Conversation | null {
  assertConversationId(id);
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.messages.push(msg);
  if (autoTitleFromUser && hasDefaultTitle(c) && msg.role === "user" && msg.content.trim().length > 0) {
    c.title = msg.content.slice(0, 40) + (msg.content.length > 40 ? "..." : "");
    c.titleKind = "literal";
  }
  c.updatedAt = Date.now();
  persistConversations(convs);
  return conversationDto(c);
}

export function updateConversationMessages(id: string, messages: Conversation["messages"]): Conversation | null {
  assertConversationId(id);
  const convs = loadConversations();
  const c = convs.find(x => x.id === id);
  if (!c) return null;
  c.messages = messages;
  c.updatedAt = Date.now();
  persistConversations(convs);
  return conversationDto(c);
}
