// Conversation store durability: a read failure must never be reported as
// "no history", because every writer is load → mutate → save and would then
// persist the empty list over real data. Faults are injected on the fixture
// path only; every other fs call delegates to the real implementation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const h = vi.hoisted(() => ({
  dataDir: "",
  failOnce: null as { path: string; code: string } | null,
  failAlways: null as { path: string; code: string } | null,
  failBackup: false,
  realReadFileSync: null as null | ((file: any, ...rest: any[]) => any),
}));

vi.mock("../../src/main/services/config-manager.js", () => ({
  getAppDataDir: () => h.dataDir,
}));

function errno(code: string, p: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: injected test fault, open '${p}'`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  h.realReadFileSync = actual.readFileSync as any;
  return {
    ...actual,
    readFileSync: (file: any, ...rest: any[]) => {
      const p = String(file);
      if (h.failAlways && p === h.failAlways.path) throw errno(h.failAlways.code, p);
      if (h.failOnce && p === h.failOnce.path) {
        const armed = h.failOnce;
        h.failOnce = null;
        throw errno(armed.code, p);
      }
      return (actual.readFileSync as any)(file, ...rest);
    },
    copyFileSync: (src: any, dest: any, flags?: number) => {
      if (h.failBackup) throw errno("EACCES", String(dest));
      return actual.copyFileSync(src, dest, flags);
    },
  };
});

const store = await import("../../src/main/services/agent/conversation-store.js");

const convPath = () => path.join(h.dataDir, "agent-conversations.json");
/** Read the fixture bytes with a fault-free reader: the injected fault targets
 *  the production code path, not the assertions about what is on disk. */
const readDisk = () => h.realReadFileSync!(convPath(), "utf-8") as string;
const backups = () =>
  fs.readdirSync(h.dataDir).filter((name) => name.includes(".corrupt"));

describe("conversation store durability", () => {
  beforeEach(() => {
    h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-store-"));
    h.failOnce = null;
    h.failAlways = null;
    h.failBackup = false;
  });
  afterEach(() => {
    h.failOnce = null;
    h.failAlways = null;
    h.failBackup = false;
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  });

  it("treats a genuinely absent file as an empty history (first run)", () => {
    expect(fs.existsSync(convPath())).toBe(false);
    expect(store.loadConversations()).toEqual([]);
    expect(store.listConversations()).toEqual([]);
  });

  it("round-trips create, message, lookup, list, rename and delete", () => {
    const first = store.createConversation("Project Alpha");
    const second = store.createConversation("Project Beta");
    expect(store.loadConversations().map((c) => c.title).sort()).toEqual([
      "Project Alpha",
      "Project Beta",
    ]);

    store.addMessage(first.id, { role: "user", content: "hello" });
    expect(store.getConversation(first.id)?.messages).toHaveLength(1);
    expect(store.getConversation("conv_missing")).toBeNull();

    // Both conversations were created inside the same millisecond, so ordering
    // is not a stable assertion here. What matters is that the touched
    // conversation was persisted with its message.
    expect(store.listConversations().map((c) => c.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    expect(store.renameConversation(first.id, "Renamed")?.title).toBe("Renamed");
    expect(store.getConversation(first.id)?.title).toBe("Renamed");

    expect(store.deleteConversation(second.id)).toBe(true);
    expect(store.deleteConversation(second.id)).toBe(false);
    expect(store.loadConversations().map((c) => c.id)).toEqual([first.id]);

    // Persisted, not just in memory.
    const onDisk = JSON.parse(readDisk());
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].messages).toHaveLength(1);

    // A new load reads the persisted file, not a cached conversation list.
    expect(store.listConversations().map((c) => c.title)).toEqual(["Renamed"]);
  });

  it("round-trips run and request metadata on conversation messages", () => {
    const conversation = store.createConversation("Traceable task");
    const message = {
      role: "assistant",
      content: "finished",
      toolResults: [{ tool: "browser_click", ok: true }],
      timestamp: 1_700_000_000_000,
      runId: "run_metadata_1",
      requestId: "request_metadata_1",
      endReason: "completed" as const,
      verification: { status: "unverified" as const },
    };

    const updated = store.addMessage(conversation.id, message);
    expect(updated?.messages).toEqual([message]);
    expect(store.getConversation(conversation.id)?.messages).toEqual([message]);
    expect(JSON.parse(readDisk())[0].messages).toEqual([message]);
  });

  it("throws on a transient read error instead of overwriting history", () => {
    const alpha = store.createConversation("Project Alpha");
    store.createConversation("Project Beta");
    store.addMessage(alpha.id, { role: "user", content: "keep me" });
    const before = readDisk();

    h.failOnce = { path: convPath(), code: "EIO" };
    expect(() => store.createConversation("New Chat")).toThrow(expect.objectContaining({
      message: expect.stringMatching(/EIO|Failed to read/i),
      cause: expect.objectContaining({ code: "EIO" }),
    }));

    // The one-shot fault is spent, so the real history is visible again.
    expect(readDisk()).toBe(before);
    expect(backups(), "a transient read error is not corruption").toEqual([]);
    expect(store.listConversations().map((c) => c.title).sort()).toEqual([
      "Project Alpha",
      "Project Beta",
    ]);
    expect(store.getConversation(alpha.id)?.messages).toEqual([
      { role: "user", content: "keep me" },
    ]);
  });

  it("keeps failing while the read keeps failing, then recovers", () => {
    store.createConversation("Project Alpha");
    const before = readDisk();

    h.failAlways = { path: convPath(), code: "EACCES" };
    expect(() => store.loadConversations()).toThrow(/EACCES|Failed to read/i);
    expect(() => store.loadConversations()).toThrow(/EACCES|Failed to read/i);
    expect(() => store.listConversations()).toThrow(/EACCES|Failed to read/i);
    expect(() => store.addMessage("conv_any", { role: "user", content: "x" })).toThrow();
    expect(readDisk()).toBe(before);
    expect(backups(), "a permission error is not corruption").toEqual([]);

    h.failAlways = null;
    expect(store.listConversations().map((c) => c.title)).toEqual(["Project Alpha"]);
  });

  it("preserves malformed JSON and backs it up without leaking its contents", () => {
    const raw = '{ "broken": "super-secret-history-content"';
    fs.writeFileSync(convPath(), raw, "utf-8");

    let error: Error | null = null;
    try {
      store.loadConversations();
    } catch (e) {
      error = e as Error;
    }
    expect(error, "malformed history must not load as an empty list").not.toBeNull();
    expect(error!.message).not.toContain("super-secret-history-content");
    expect(error!.message).toMatch(/not valid JSON/i);

    // Original untouched, and a salvage copy exists beside it.
    expect(readDisk()).toBe(raw);
    const copies = backups();
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.dataDir, copies[0]), "utf-8")).toBe(raw);

    // Still a failure on the next read — not silently "no conversations yet".
    expect(() => store.loadConversations()).toThrow(/not valid JSON/i);
    expect(backups()).toHaveLength(2);
    for (const copy of backups()) {
      expect(fs.readFileSync(path.join(h.dataDir, copy), "utf-8")).toBe(raw);
    }
  });

  it("rejects a non-array root and preserves the file", () => {
    const raw = '{"conversations": []}';
    fs.writeFileSync(convPath(), raw, "utf-8");

    expect(() => store.loadConversations()).toThrow(/array/i);
    expect(readDisk()).toBe(raw);
    expect(backups()).toHaveLength(1);
    expect(() => store.createConversation("New Chat")).toThrow(/array/i);
    expect(readDisk()).toBe(raw);
  });

  it("surfaces the load failure even when the salvage backup fails", () => {
    const raw = "{ not json at all";
    fs.writeFileSync(convPath(), raw, "utf-8");
    h.failBackup = true;

    let error: Error | null = null;
    try {
      store.loadConversations();
    } catch (e) {
      error = e as Error;
    }
    expect(error, "a failed backup must not turn a load failure into success").not.toBeNull();
    expect(error!.message).toMatch(/backup failed/i);

    h.failBackup = false;
    expect(backups()).toEqual([]);
    expect(readDisk()).toBe(raw);
    expect(() => store.loadConversations()).toThrow(/not valid JSON/i);
  });
});
