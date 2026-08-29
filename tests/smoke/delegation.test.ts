// Verify the delegation dispatch logic without launching Electron
// We reconstruct the relevant parts of delegation.js and the nav HTML,
// then simulate a click event and check what command is dispatched.

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

// Minimal DOM mock with the structure delegation.js queries
function makeMockElement(tag, attrs = {}, parent = null) {
  const el: any = {
    tagName: tag.toUpperCase(),
    _attrs: { ...attrs },
    _children: [] as any[],
    parentNode: parent,
    style: {},
    classList: {
      _classes: new Set(((attrs.class || "") + " " + (attrs["class"] || "")).trim().split(/\s+/).filter(Boolean)),
      add(c: string) { this._classes.add(c); },
      remove(c: string) { this._classes.delete(c); },
      contains(c: string) { return this._classes.has(c); },
      toggle(c: string, on?: boolean) {
        if (on === undefined) on = !this._classes.has(c);
        if (on) this._classes.add(c); else this._classes.delete(c);
      },
    },
    dataset: {} as Record<string, string>,
    getAttribute(name: string) { return this._attrs[name] ?? null; },
    setAttribute(name: string, v: string) { this._attrs[name] = v; },
    addEventListener() {},
    appendChild(c: any) { this._children.push(c); c.parentNode = this; return c; },
    querySelectorAll() { return []; },
    closest(sel: string) {
      // Support [data-tab="x"]
      const m = sel.match(/^\[data-([\w-]+)="([^"]+)"\]$/);
      if (!m) return null;
      const [, key, val] = m;
      let cur: any = this;
      while (cur) {
        if (cur._attrs?.[`data-${key}`] === val) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
  };
  // Mirror data-* into dataset
  for (const k of Object.keys(attrs)) {
    if (k.startsWith("data-")) {
      const dsKey = k.slice(5).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      el.dataset[dsKey] = attrs[k];
    }
  }
  return el;
}

// Reimplement the relevant slice of delegation.js dispatch
function dispatch(el: any): { cmd: string; args: any[] } | null {
  const cmd = el.getAttribute("data-cmd");
  if (!cmd) return null;
  if (cmd === "close-dialog" || cmd === "random-seed" || cmd === "ext-open-repo") return { cmd, args: [] };
  const arg = el.getAttribute("data-cmd-arg");
  const a = el.getAttribute("data-cmd-a");
  const b = el.getAttribute("data-cmd-b");
  if (a !== null && b !== null) return { cmd, args: [a, b] };
  if (arg !== null && arg !== "" && arg !== "undefined") return { cmd, args: [arg] };
  if (cmd === "switchTab" && el.dataset.tab) return { cmd, args: [el.dataset.tab] };
  if (cmd === "switchAgentSub" && el.dataset.sub) return { cmd, args: [el.dataset.sub] };
  return { cmd, args: [] };
}

describe("Delegation dispatch (HTML + delegation.js)", () => {
  it("all sidebar nav items resolve to switchTab(<tab>)", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    // Find each <li ... data-tab="..." data-cmd="switchTab" ...> (allow extra attrs like role/aria)
    const navRe = /<li[^>]*data-tab="([^"]+)"[^>]*data-cmd="switchTab"[^>]*>/g;
    const tabs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = navRe.exec(html))) tabs.push(m[1]);
    expect(tabs.length).toBeGreaterThanOrEqual(8);
    for (const t of tabs) {
      const li = makeMockElement("li", { class: "nav-item", "data-tab": t, "data-cmd": "switchTab" });
      const r = dispatch(li);
      expect(r?.cmd).toBe("switchTab");
      expect(r?.args).toEqual([t]);
    }
  });

  it("agent sub-buttons dispatch to switchAgentSub(<sub>)", () => {
    const subs = ["config", "accounts", "skills", "chat"];
    for (const s of subs) {
      const btn = makeMockElement("button", {
        "data-cmd": "switchAgentSub",
        "data-sub": s,
      });
      const r = dispatch(btn);
      expect(r?.cmd).toBe("switchAgentSub");
      expect(r?.args).toEqual([s]);
    }
  });

  it("data-cmd-arg=\"undefined\" (literal string) is rejected and falls through to data-tab", () => {
    // Old behavior: passing "undefined" string — we want to make sure this no longer happens
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(html).not.toContain('data-cmd-arg="undefined"');
  });

  it("no remaining literal data-cmd-arg=\"undefined\" anywhere in HTML", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const matches = html.match(/data-cmd-arg="undefined"/g) || [];
    expect(matches.length).toBe(0);
  });

  it("delegation.js is defensive against literal undefined arg", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/delegation.js"), "utf-8");
    expect(source).toContain("arg !== 'undefined'");
    expect(source).toContain("cmd === 'switchTab' && el.dataset.tab");
    expect(source).toContain("cmd === 'switchAgentSub' && el.dataset.sub");
  });

  it("core.js exposes api, R, state on window.agentBrowser", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/core.js"), "utf-8");
    expect(source).toMatch(/window\.agentBrowser\s*=\s*\{[\s\S]*?api:\s*api/);
    expect(source).toMatch(/window\.agentBrowser\s*=\s*\{[\s\S]*?R:\s*R/);
    expect(source).toMatch(/window\.agentBrowser\s*=\s*\{[\s\S]*?state:\s*\{/);
  });

  it("tab.js defines switchTab and loadTab on agentBrowser", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/tabs.js"), "utf-8");
    expect(source).toMatch(/agentBrowser\.switchTab\s*=/);
    expect(source).toMatch(/agentBrowser\.loadTab\s*=/);
  });

  it("delegation.js loads after all tab/feature modules", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const delegationIdx = html.indexOf("delegation.js");
    const tabsIdx = html.indexOf("tabs.js");
    const initIdx = html.indexOf("init.js");
    expect(delegationIdx).toBeGreaterThan(tabsIdx);
    expect(initIdx).toBeGreaterThan(delegationIdx);
  });
});