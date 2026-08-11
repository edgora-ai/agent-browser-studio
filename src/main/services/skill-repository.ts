import * as crypto from "node:crypto";
import { getConfig, saveConfig } from "./config-manager.js";
import type { SkillRepositoryEntry } from "../types.js";

export interface AgentSkill {
  name: string;
  description: string;
  tools: string[];
  prompt: string;
}

export type SkillInput = Partial<Omit<SkillRepositoryEntry, "addedAt" | "updatedAt" | "packageHash">> & {
  id: string;
  prompt: string;
};

export type SharedSkillEntry = Pick<SkillRepositoryEntry, "id" | "name" | "title" | "version" | "description" | "source" | "tools" | "prompt" | "shared" | "tags" | "author" | "homepage">;

export const BUILTIN_SKILLS: AgentSkill[] = [
  {
    name: "browser-automation",
    description: "Full browser control — navigate, click, type, scroll, screenshot, evaluate JS",
    tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot", "browser_scroll", "browser_press_key", "browser_hover", "browser_select", "browser_wait_for", "browser_get_text", "browser_get_url", "browser_get_title", "browser_get_cookies"],
    prompt: `You are a browser automation agent. Control Agent Browser Studio managed Chromium using CDP tools.
Always: navigate → wait → snapshot → act. Use CSS selectors from snapshots.`,
  },
  {
    name: "account-autofill",
    description: "Auto-fill login credentials from local account store",
    tools: ["list_accounts", "browser_navigate", "browser_type", "browser_click", "browser_snapshot", "browser_wait_for"],
    prompt: `You are a login automation agent. Given a website, use list_accounts() to find credentials, then navigate, snapshot, fill username/password fields, and click submit.`,
  },
  {
    name: "data-extraction",
    description: "Extract structured data from web pages",
    tools: ["browser_navigate", "browser_wait_for", "browser_snapshot", "browser_get_text", "browser_screenshot"],
    prompt: `You are a web scraping agent. Navigate to URL, wait for content, evaluate JS selectors, return structured JSON.`,
  },
  {
    name: "profile-manager",
    description: "Manage browser profiles — list, launch, check status",
    tools: ["list_profiles", "launch_profile"],
    prompt: `You help users manage their Agent Browser Studio Chromium profiles. List profiles, suggest which to use, help launch them.`,
  },
];

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function listSkillRepository(filter?: string): SkillRepositoryEntry[] {
  const entries = getMergedSkillEntries();
  const normalizedFilter = String(filter || "").trim().toLowerCase();
  const filtered = normalizedFilter
    ? entries.filter((entry) => [entry.id, entry.name, entry.title, entry.description, ...entry.tags].some((value) => String(value || "").toLowerCase().includes(normalizedFilter)))
    : entries;
  return filtered.sort((a, b) => a.title.localeCompare(b.title));
}

export function listMarketplaceSkills(filter?: string): SkillRepositoryEntry[] {
  return listSkillRepository(filter);
}

export function getSkill(id: string): SkillRepositoryEntry | null {
  validateSkillId(id);
  return getMergedSkillEntries().find((entry) => entry.id === id) || null;
}

export function addOrUpdateSkill(input: SkillInput): SkillRepositoryEntry {
  const id = normalizeSkillId(input.id);
  const now = Date.now();
  const cfg = structuredClone(getConfig()) as any;
  cfg.skillRepository = cfg.skillRepository || {};
  const previous = cfg.skillRepository[id] as SkillRepositoryEntry | undefined;
  const entry = normalizeSkillEntry({
    id,
    name: input.name || input.title || id,
    title: input.title || input.name || id,
    version: input.version || previous?.version || "1.0.0",
    description: input.description || "",
    source: input.source === "shared-catalog" ? "shared-catalog" : "local",
    tools: input.tools || previous?.tools || [],
    prompt: input.prompt,
    shared: input.shared ?? previous?.shared ?? false,
    enabled: input.enabled ?? previous?.enabled ?? true,
    tags: input.tags || previous?.tags || [],
    author: input.author || previous?.author,
    homepage: input.homepage || previous?.homepage,
    packageHash: hashSkillPayload(input.prompt, input.tools || previous?.tools || []),
    addedAt: previous?.addedAt || now,
    updatedAt: now,
  });
  cfg.skillRepository[id] = entry;
  saveConfig(cfg);
  return entry;
}

export function installSkill(id: string): SkillRepositoryEntry {
  validateSkillId(id);
  const skill = getSkill(id);
  if (!skill) throw new Error("Skill not found");
  return setSkillMeta(id, { enabled: true });
}

export function removeSkill(id: string): boolean {
  validateSkillId(id);
  const cfg = structuredClone(getConfig()) as any;
  cfg.skillRepository = cfg.skillRepository || {};
  if (isBuiltInSkill(id)) {
    const current = buildBuiltinEntry(BUILTIN_SKILLS.find((skill) => skill.name === id)!);
    cfg.skillRepository[id] = { ...current, ...(cfg.skillRepository[id] || {}), enabled: false, updatedAt: Date.now() };
  } else if (cfg.skillRepository[id]) {
    delete cfg.skillRepository[id];
  } else {
    return false;
  }
  saveConfig(cfg);
  return true;
}

export function setSkillMeta(id: string, opts: { shared?: boolean; enabled?: boolean; tags?: string[] }): SkillRepositoryEntry {
  validateSkillId(id);
  const current = getSkill(id);
  if (!current) throw new Error("Skill not found");
  const cfg = structuredClone(getConfig()) as any;
  cfg.skillRepository = cfg.skillRepository || {};
  const stored = cfg.skillRepository[id] || current;
  if (opts.shared !== undefined) stored.shared = Boolean(opts.shared);
  if (opts.enabled !== undefined) stored.enabled = Boolean(opts.enabled);
  if (opts.tags !== undefined) stored.tags = normalizeTags(opts.tags);
  stored.updatedAt = Date.now();
  cfg.skillRepository[id] = normalizeSkillEntry(stored);
  saveConfig(cfg);
  return cfg.skillRepository[id];
}

export function exportSharedSkillRepository(): SharedSkillEntry[] {
  return listSkillRepository().filter((entry) => entry.shared).map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    version: entry.version,
    description: entry.description,
    source: entry.source === "built-in" ? "shared-catalog" : entry.source,
    tools: entry.tools,
    prompt: entry.prompt,
    shared: true,
    tags: entry.tags,
    author: entry.author,
    homepage: entry.homepage,
  }));
}

/**
 * Imports a shared skill catalog. Imports are conservative: an imported entry
 * is **never allowed to overwrite** an existing local/shared/built-in skill.
 * This is a deliberate security boundary — imported prompts are untrusted
 * recipes and must not be able to silently replace what the user already has.
 *
 * Result fields:
 * - `added` — number of new skills inserted
 * - `skipped` — entries that were rejected (duplicate ID in catalog, ID already
 *   present in repository or built-in, validation failure)
 * - `updated` — always 0; retained for backward compatibility
 */
export function importSharedSkillRepository(entries: SharedSkillEntry[]): { added: number; updated: number; skipped: number } {
  if (!Array.isArray(entries)) throw new Error("Shared skill catalog must be an array");
  const cfg = structuredClone(getConfig()) as any;
  const repository = { ...(cfg.skillRepository || {}) } as Record<string, SkillRepositoryEntry>;
  let added = 0;
  let skipped = 0;
  const now = Date.now();
  const validated: Array<{ id: string; entry: SkillRepositoryEntry }> = [];
  const seen = new Set<string>();
  for (const raw of entries.slice(0, 200)) {
    try {
      const id = normalizeSkillId(raw.id);
      if (isBuiltInSkill(id) || seen.has(id) || repository[id]) { skipped++; continue; }
      seen.add(id);
      const entry = normalizeSkillEntry({
        id,
        name: raw.name || raw.title || id,
        title: raw.title || raw.name || id,
        version: raw.version || "1.0.0",
        description: raw.description || "",
        source: "shared-catalog",
        tools: raw.tools || [],
        prompt: raw.prompt,
        shared: Boolean(raw.shared),
        enabled: false,
        tags: raw.tags || [],
        author: raw.author,
        homepage: raw.homepage,
        packageHash: hashSkillPayload(raw.prompt, raw.tools || []),
        addedAt: now,
        updatedAt: now,
      });
      validated.push({ id, entry });
    } catch (error) {
      skipped++;
    }
  }
  for (const item of validated) {
    repository[item.id] = item.entry;
    added++;
  }
  cfg.skillRepository = repository;
  saveConfig(cfg);
  return { added, updated: 0, skipped };
}

export function getEnabledSkillPrompts(): Array<{ id: string; title: string; prompt: string; tools: string[] }> {
  return listSkillRepository()
    .filter((entry) => entry.enabled)
    .map((entry) => ({ id: entry.id, title: entry.title, prompt: entry.prompt, tools: entry.tools }));
}

function getMergedSkillEntries(): SkillRepositoryEntry[] {
  const cfg = getConfig() as any;
  const repository = cfg.skillRepository || {};
  const merged = new Map<string, SkillRepositoryEntry>();
  for (const builtin of BUILTIN_SKILLS) {
    const base = buildBuiltinEntry(builtin);
    const override = repository[base.id] as SkillRepositoryEntry | undefined;
    merged.set(base.id, normalizeSkillEntry({ ...base, ...(override || {}), source: "built-in" }));
  }
  for (const [id, entry] of Object.entries(repository) as Array<[string, SkillRepositoryEntry]>) {
    if (merged.has(id)) continue;
    merged.set(id, normalizeSkillEntry(entry));
  }
  return [...merged.values()];
}

function buildBuiltinEntry(skill: AgentSkill): SkillRepositoryEntry {
  const now = 1710000000000;
  return {
    id: skill.name,
    name: skill.name,
    title: titleFromSkillName(skill.name),
    version: "1.0.0",
    description: skill.description,
    source: "built-in",
    tools: skill.tools,
    prompt: skill.prompt,
    shared: false,
    enabled: true,
    tags: ["built-in"],
    addedAt: now,
    updatedAt: now,
  };
}

function titleFromSkillName(name: string): string {
  return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function isBuiltInSkill(id: string): boolean {
  return BUILTIN_SKILLS.some((skill) => skill.name === id);
}

function normalizeSkillEntry(entry: SkillRepositoryEntry): SkillRepositoryEntry {
  const id = normalizeSkillId(entry.id);
  const source = entry.source === "built-in" || entry.source === "local" || entry.source === "shared-catalog" ? entry.source : "local";
  return {
    id,
    name: sanitizeText(entry.name || id, 80) || id,
    title: sanitizeText(entry.title || entry.name || id, 120) || id,
    version: sanitizeText(entry.version || "1.0.0", 40) || "1.0.0",
    description: sanitizeText(entry.description || "", 500),
    source,
    tools: normalizeTools(entry.tools || []),
    prompt: sanitizePrompt(entry.prompt),
    shared: Boolean(entry.shared),
    enabled: Boolean(entry.enabled),
    tags: normalizeTags(entry.tags || []),
    author: entry.author ? sanitizeText(entry.author, 120) : undefined,
    homepage: entry.homepage ? sanitizeHttpsUrl(entry.homepage) : undefined,
    packageHash: entry.packageHash,
    addedAt: sanitizeTimestamp(entry.addedAt),
    updatedAt: sanitizeTimestamp(entry.updatedAt),
  };
}

function validateSkillId(id: string): void {
  if (!SKILL_ID_RE.test(id) || id === "__proto__" || id === "constructor" || id === "prototype") {
    throw new Error(`Invalid skill ID: ${JSON.stringify(id)}`);
  }
}

function normalizeSkillId(id: string): string {
  const normalized = String(id || "").trim().toLowerCase();
  validateSkillId(normalized);
  return normalized;
}

function sanitizeText(value: unknown, maxLength: number): string {
  return String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, maxLength);
}

function sanitizePrompt(value: unknown): string {
  const prompt = sanitizeText(value, 12000);
  if (!prompt) throw new Error("Skill prompt is required");
  return prompt;
}

function normalizeTools(tools: unknown[]): string[] {
  return [...new Set(tools.map((tool) => sanitizeText(tool, 80)).filter(Boolean))].slice(0, 50);
}

function normalizeTags(tags: unknown[]): string[] {
  return [...new Set(tags.map((tag) => sanitizeText(tag, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}

function sanitizeHttpsUrl(value: unknown): string | undefined {
  const raw = sanitizeText(value, 500);
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("Skill URL must use HTTPS");
  return parsed.toString();
}

function sanitizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();
}

function hashSkillPayload(prompt: string, tools: unknown[]): string {
  return crypto.createHash("sha512").update(JSON.stringify({ prompt, tools })).digest("hex");
}
