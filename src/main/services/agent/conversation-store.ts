import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir } from "../config-manager.js";

export interface Conversation {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; toolResults?: any[]; timestamp?: number }>;
  createdAt: number;
  updatedAt: number;
}

export function conversationsPath(): string {
  return path.join(getAppDataDir(), "agent-conversations.json");
}

export function loadConversations(): Conversation[] {
  const p = conversationsPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return []; }
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

export function addMessage(id: string, msg: { role: string; content: string; timestamp?: number }): Conversation | null {
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
