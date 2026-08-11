// Locator helpers — robust, language-agnostic Playwright locators.
import type { Locator, Page } from "playwright";

export function dataTab(page: Page, tab: string): Locator {
  return page.locator(`.nav-item[data-tab="${tab}"]`);
}

export function cmd(page: Page, cmdName: string, opts?: { scope?: Locator | Page }): Locator {
  const scope = opts?.scope ?? page;
  return scope.locator(`[data-cmd="${cmdName}"]`);
}

export async function clickCmd(
  page: Page,
  cmdName: string,
  opts?: { scope?: Locator | Page; timeout?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  await cmd(page, cmdName, opts).first().click({ timeout });
}

export function profileCard(page: Page, nameOrDirId: string): Locator {
  return page.locator(`.profile-card:has-text("${nameOrDirId}")`).first();
}

export async function waitForProfiles(
  page: Page,
  count: number,
  timeoutMs = 10000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page.locator(".profile-card").count();
    if (n >= count) return n;
    await page.waitForTimeout(150);
  }
  return page.locator(".profile-card").count();
}

export async function invokeAgentBrowser<T = unknown>(
  page: Page,
  expression: string,
  arg?: unknown,
): Promise<T> {
  return page.evaluate(
    ({ expression: expr, arg: a }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "arg",
        "with (window) { return (function() { " + expr + " }).call(window); }",
      );
      return fn(a);
    },
    { expression, arg },
  );
}
