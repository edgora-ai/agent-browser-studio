import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

const environment = vi.hoisted(() => {
  const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-test-async-")));
  const owner = fs.lstatSync(root, { bigint: true });
  return { root, home: path.join(root, "app"), assertOwned: () => {
    const current = fs.lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) {
      throw new Error("Async profile fixture root changed");
    }
  } };
});

// Synthetic stopped profiles have no owned running browser. Keep discovery and
// SQLite execution at controlled boundaries; no host command is needed here.
const subprocess = vi.hoisted(() => ({
  sqlite: vi.fn(),
  forbidden: vi.fn(() => { throw new Error("Unexpected subprocess execution"); }),
}));
vi.mock("node:child_process", () => ({
  exec: subprocess.forbidden, fork: subprocess.forbidden,
  execFileSync: subprocess.sqlite, execFile: subprocess.forbidden,
  execSync: subprocess.forbidden, spawn: subprocess.forbidden, spawnSync: subprocess.forbidden,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
vi.mock("../../src/main/services/process-discovery.js", () => ({
  // Loading the real dependency from a hoisted factory can re-enter the
  // profile/browser import graph before this fixture is initialized.
  parseBrowserProcessLine: subprocess.forbidden,
  getRunningProcessesAsync: async () => [],
  getRunningProcessesSync: () => [],
  findBrowserByProfileSync: () => null,
  findBrowserByProfileAsync: async () => null,
}));

// 1. Mock Electron app before importing managers
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "home" || name === "userData") return environment.home;
      if (name === "temp") return environment.root;
      throw new Error(`Unexpected Electron path request: ${name}`);
    }
  }
}));

const TEST_HOME = environment.home;
function clearOwnedHome() {
  environment.assertOwned();
  if (fs.existsSync(TEST_HOME)) {
    const home = fs.lstatSync(TEST_HOME);
    if (!home.isDirectory() || home.isSymbolicLink()) throw new Error("Async profile fixture home changed");
    fs.rmSync(TEST_HOME, { recursive: true });
  }
}

// Import the services under test
import {
  listProfiles,
  getProfileInfo,
  deleteProfile,
  listCookies,
  setCookie,
  deleteCookie,
} from "../../src/main/services/profile-manager.js";
import {
  createBrowserProfile,
  deleteBrowserProfile,
} from "../../src/main/services/browser-manager.js";
import { storageMonitor } from "../../src/main/services/storage-monitor.js";
import { getProfilesDir } from "../../src/main/services/config-manager.js";

const statfs = vi.mocked(fsPromises.statfs);
describe("Asynchronous Profile & Storage Monitor Operations", () => {
  beforeEach(async () => {
    subprocess.sqlite.mockReset();
    subprocess.sqlite.mockImplementation(() => { throw new Error("Unexpected SQLite execution"); });
    statfs.mockReset().mockImplementation(fs.promises.statfs);
    subprocess.forbidden.mockClear();
    clearOwnedHome();
    const profilesDir = getProfilesDir();
    const relative = path.relative(TEST_HOME, profilesDir);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Async profiles directory escaped the owned fixture home");
    }
    fs.mkdirSync(profilesDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      expect(subprocess.forbidden).not.toHaveBeenCalled();
    } finally {
      clearOwnedHome();
    }
  });
  afterAll(() => {
    environment.assertOwned();
    fs.rmSync(environment.root, { recursive: true });
  });

  it("should create, list, info, and delete managed Chromium profiles asynchronously", async () => {
    // 1. Create a profile
    const { dirId } = createBrowserProfile({ name: "AsyncTestProfile" });
    expect(dirId).toBeDefined();
    expect(dirId).toMatch(/^ab_/);

    const profilePath = path.join(getProfilesDir(), dirId);
    fs.mkdirSync(profilePath, { recursive: true });

    // Write a dummy file to the profile to give it size
    const dummyFile = path.join(profilePath, "dummy.txt");
    fs.writeFileSync(dummyFile, "hello world 12345"); // 17 bytes

    // 2. Get profile info
    const info = await getProfileInfo(dirId);
    expect(info.name).toBe("AsyncTestProfile");
    expect(info.sizeBytes).toBeGreaterThan(0);

    // 3. List profiles
    const profiles = await listProfiles();
    expect(profiles.some(p => p.dirId === dirId)).toBe(true);

    // 4. Delete profile
    const deleted = await deleteProfile(dirId);
    expect(deleted).toBe(true);
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  it("keeps stopped profile cookie writes read-only", async () => {
    const { dirId } = createBrowserProfile({ name: "CookieReadOnlyProfile" });
    await expect(setCookie(dirId, { domain: "example.com", name: "sid", value: "abc" })).rejects.toThrow(/Launch this profile/);
    await expect(deleteCookie(dirId, "example.com", "sid")).rejects.toThrow(/Launch this profile/);
    await expect(listCookies(dirId)).resolves.toEqual([]);
  });

  it("escapes stopped profile cookie search wildcards for SQLite", async () => {
    const { dirId } = createBrowserProfile({ name: "CookieSearchProfile" });
    const cookieDb = path.join(getProfilesDir(), dirId, "Default", "Cookies");
    fs.writeFileSync(cookieDb, "not a real sqlite database");
    // This case requires an available SQLite command that rejects the corrupt
    // database, not the intentional missing-executable ENOENT fallback to [].
    subprocess.sqlite.mockImplementation(() => {
      throw Object.assign(new Error("Error: file is not a database"), { code: 1 });
    });

    for (const filter of ["g", "_"]) {
      const search = listCookies(dirId, filter);
      await expect(search).rejects.not.toThrow(/ESCAPE expression/);
      await expect(search).rejects.toMatchObject({ message: "Error: file is not a database", code: 1 });
    }
    expect(subprocess.sqlite).toHaveBeenCalledTimes(2);
    // Keep argument assertions outside the production error/rejection path.
    for (const [index, filter] of ["g", "~_"].entries()) {
      expect(subprocess.sqlite).toHaveBeenNthCalledWith(index + 1, "sqlite3",
        expect.arrayContaining([cookieDb, `.parameter set :filter ${JSON.stringify(filter)}`]),
        { encoding: "utf-8", timeout: 5000 });
    }
  });

  it("storageMonitor should query info and clear cache asynchronously", async () => {
    const { dirId } = createBrowserProfile({ name: "StorageTest", fingerprintSeed: 12345 });
    const profilePath = path.join(getProfilesDir(), dirId);
    const cachePath = path.join(profilePath, "Cache");
    const cacheData = "some cached data here";
    const persistentData = "persistent fixture data";
    const keep = path.join(profilePath, "keep");
    fs.mkdirSync(cachePath, { recursive: true });
    fs.writeFileSync(path.join(cachePath, "data_0"), cacheData);
    fs.writeFileSync(keep, persistentData);
    expect(fs.readFileSync(path.join(cachePath, "data_0"), "utf8")).toBe(cacheData);
    expect(fs.readFileSync(keep, "utf8")).toBe(persistentData);

    const info = await storageMonitor.getInfo();
    expect(info.profiles).toHaveLength(1);
    expect(info.profiles[0]).toMatchObject({ dirId, name: "StorageTest" });
    expect(info.totalProfileBytes).toBe(info.profiles[0].sizeBytes);
    expect(info.totalProfileBytes).toBeGreaterThanOrEqual(Buffer.byteLength(cacheData + persistentData));
    // Observe the one native snapshot actually used, not a later moving sample.
    expect(statfs).toHaveBeenCalledExactlyOnceWith(getProfilesDir(), { bigint: true });
    const snapshot = await statfs.mock.results[0].value as fs.BigIntStatsFs;
    const available = Number(snapshot.bavail * snapshot.bsize);
    const total = Number(snapshot.blocks * snapshot.bsize);
    expect(info.availableDiskBytes).toBe(available);
    expect(info.diskUsagePercent).toBe(Math.round(((total - available) / total) * 100));

    expect(await storageMonitor.clearCache(dirId)).toEqual({ freed: Buffer.byteLength(cacheData) });
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(fs.readFileSync(keep, "utf8")).toBe(persistentData);
    const after = await storageMonitor.getInfo();
    expect(after.totalProfileBytes).toBe(info.totalProfileBytes - Buffer.byteLength(cacheData));
    expect(after.profiles.find(profile => profile.dirId === dirId)).toMatchObject({
      name: "StorageTest", sizeBytes: info.profiles[0].sizeBytes - Buffer.byteLength(cacheData),
    });
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(statfs).toHaveBeenLastCalledWith(getProfilesDir(), { bigint: true });
  });
});

// Mock browser objects to test page-context resolver logic in Node
class MockNode {
  tagName: string;
  shadowRoot: MockNode | null = null;
  contentDocument: MockNode | null = null;
  contentWindow: { document: MockNode } | null = null;
  _children: MockNode[] = [];
  _attributes: Record<string, string> = {};
  ownerDocument: { defaultView: any } | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this._attributes = attrs;
  }

  querySelector(selector: string): MockNode | null {
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      if (this._attributes.id === id) return this;
    } else if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      if (this._attributes.class === cls) return this;
    } else {
      if (this.tagName.toLowerCase() === selector.toLowerCase()) return this;
    }
    for (const child of this._children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 100, height: 50 };
  }
}

describe("Page-Context Selector Resolver Algorithm", () => {
  function querySelectorDeep(selector: string, root: any): any {
    const el = root.querySelector(selector);
    if (el) return el;

    const walker = new MockTreeWalker(root);
    let node = walker.currentNode();
    while (node) {
      if (node.shadowRoot) {
        const found = querySelectorDeep(selector, node.shadowRoot);
        if (found) return found;
      }
      if (node.tagName === "IFRAME") {
        try {
          const iframeDoc = node.contentDocument || node.contentWindow?.document;
          if (iframeDoc) {
            const found = querySelectorDeep(selector, iframeDoc);
            if (found) return found;
          }
        } catch {}
      }
      node = walker.nextNode();
    }
    return null;
  }

  function resolveSelector(selector: string, doc: any): any {
    const parts = selector.split(">>>").map(p => p.trim());
    let current = doc;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const found = querySelectorDeep(part, current);
      if (!found) return null;
      if (i < parts.length - 1) {
        if (found.shadowRoot) {
          current = found.shadowRoot;
        } else if (found.tagName === "IFRAME") {
          current = found.contentDocument || found.contentWindow?.document || found;
        } else {
          current = found;
        }
      } else {
        return found;
      }
    }
    return null;
  }

  class MockTreeWalker {
    private flatNodes: MockNode[] = [];
    private index = 0;

    constructor(root: MockNode) {
      this.flatten(root);
    }

    private flatten(node: MockNode) {
      this.flatNodes.push(node);
      for (const child of node._children) {
        this.flatten(child);
      }
    }

    currentNode() {
      return this.flatNodes[this.index] || null;
    }

    nextNode() {
      this.index++;
      return this.flatNodes[this.index] || null;
    }
  }

  it("should find elements inside a nested Shadow DOM structure", () => {
    const rootDoc = new MockNode("document");
    const container = new MockNode("div", { id: "container" });
    const shadowHost = new MockNode("my-element");
    const shadowRoot = new MockNode("shadow-root");
    const targetButton = new MockNode("button", { id: "submit-btn" });

    rootDoc._children.push(container);
    container._children.push(shadowHost);
    shadowHost.shadowRoot = shadowRoot;
    shadowRoot._children.push(targetButton);

    // Simple deep search
    const foundDirect = querySelectorDeep("#submit-btn", rootDoc);
    expect(foundDirect).toBe(targetButton);

    // Search via explicit >>> boundary delimiter
    const foundPath = resolveSelector("my-element >>> #submit-btn", rootDoc);
    expect(foundPath).toBe(targetButton);
  });

  it("should find elements inside a nested same-origin iframe", () => {
    const rootDoc = new MockNode("document");
    const iframe = new MockNode("iframe", { id: "login-frame" });
    const iframeDoc = new MockNode("document");
    const targetInput = new MockNode("input", { class: "input-field" });

    rootDoc._children.push(iframe);
    iframe.contentDocument = iframeDoc;
    iframeDoc._children.push(targetInput);

    const foundDirect = querySelectorDeep(".input-field", rootDoc);
    expect(foundDirect).toBe(targetInput);

    const foundPath = resolveSelector("#login-frame >>> .input-field", rootDoc);
    expect(foundPath).toBe(targetInput);
  });
});
