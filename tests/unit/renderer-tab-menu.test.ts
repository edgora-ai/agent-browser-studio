import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app/tabs.js"), "utf8");

// This verifies synchronous navigation ordering, not native popup visibility.
// Actual popover cleanup and foreground rendering remain Electron E2E checks.
function harness(withCloser = true) {
  const events: string[] = [];
  const control = (id: string, tab: string) => ({
    id, dataset: { tab },
    classList: { toggle: vi.fn(() => events.push("visibility")) },
    setAttribute: vi.fn(),
  });
  const nav = [control("nav-profiles", "profiles"), control("nav-proxy", "proxy")];
  const sections = [control("tab-profiles", "profiles"), control("tab-proxy", "proxy")];
  const document = {
    querySelectorAll: (selector: string) => selector === ".nav-item" ? nav : selector === ".tab-content" ? sections : [],
  };
  const state = { currentTab: "profiles" };
  const closer = vi.fn((_scope: unknown, _restoreFocus: boolean) => {
    events.push("menus");
    expect(state.currentTab).toBe("profiles");
    for (const el of [...nav, ...sections]) expect(el.classList.toggle).not.toHaveBeenCalled();
  });
  const agentBrowser: any = { api: {}, R: {}, helpers: {}, state };
  if (withCloser) agentBrowser.closeCardMenus = closer;
  vm.runInNewContext(SOURCE, { window: { agentBrowser }, document });
  agentBrowser.loadTab = vi.fn(() => events.push("load"));
  return { agentBrowser, closer, document, state, nav, sections, events };
}

describe("tab navigation menu cleanup", () => {
  it("closes menus synchronously without stealing focus before hiding the old page", () => {
    const h = harness();
    h.agentBrowser.switchTab("proxy");
    expect(h.closer).toHaveBeenCalledExactlyOnceWith(h.document, false);
    expect(h.events[0]).toBe("menus");
    expect(h.state.currentTab).toBe("proxy");
    expect(h.sections[0].classList.toggle).toHaveBeenCalledWith("active", false);
    expect(h.sections[1].classList.toggle).toHaveBeenCalledWith("active", true);
    expect(h.agentBrowser.loadTab).toHaveBeenCalledExactlyOnceWith("proxy");
    expect(h.events.at(-1)).toBe("load");
  });

  it("resolves the shared closer at call time when delegation loads after tabs", () => {
    const h = harness(false);
    h.agentBrowser.closeCardMenus = h.closer;
    h.agentBrowser.switchTab("proxy");
    expect(h.closer).toHaveBeenCalledExactlyOnceWith(h.document, false);
    expect(h.events[0]).toBe("menus");
  });

  it("preserves navigation when running without the optional delegation module", () => {
    const h = harness(false);
    h.agentBrowser.switchTab("proxy");
    expect(h.state.currentTab).toBe("proxy");
    expect(h.agentBrowser.loadTab).toHaveBeenCalledExactlyOnceWith("proxy");
    expect(h.nav[1].setAttribute).toHaveBeenCalledWith("aria-selected", "true");
  });
});
