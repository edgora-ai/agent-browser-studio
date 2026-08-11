import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 1. Mock Electron app before importing managers
vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_HOME = path.join(os.tmpdir(), "agent-browser-test-home-async");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "home" || name === "userData") return TEST_HOME;
        return "/tmp";
      }
    }
  };
});

const TEST_HOME = require("node:path").join(require("node:os").tmpdir(), "agent-browser-test-home-async");

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

describe("Asynchronous Profile & Storage Monitor Operations", () => {
  beforeEach(async () => {
    // Clear and create directories
    if (fs.existsSync(TEST_HOME)) {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    }
    fs.mkdirSync(getProfilesDir(), { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(TEST_HOME)) {
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    }
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

    await expect(listCookies(dirId, "g")).rejects.not.toThrow(/ESCAPE expression/);
    await expect(listCookies(dirId, "_")).rejects.not.toThrow(/ESCAPE expression/);
  });

  it("storageMonitor should query info and clear cache asynchronously", async () => {
    // 1. Setup profile with some mock cache files
    const dirId = "cb_test_profile";
    const profilePath = path.join(getProfilesDir(), dirId);
    const cachePath = path.join(profilePath, "Cache");
    fs.mkdirSync(cachePath, { recursive: true });
    fs.writeFileSync(path.join(cachePath, "data_0"), "some cached data here"); // 22 bytes

    // We need config entry for storage monitor to list it
    const { createBrowserProfile: createCP } = await import("../../src/main/services/browser-manager.js");
    createCP({ name: "StorageTest", fingerprintSeed: 12345 });

    // 2. Query storage info
    const info = await storageMonitor.getInfo();
    expect(info).toBeDefined();
    expect(info.totalProfileBytes).toBeGreaterThanOrEqual(0);

    // 3. Clear cache
    const clearResult = await storageMonitor.clearCache(dirId);
    expect(clearResult.freed).toBeGreaterThanOrEqual(0);
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
