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
  const matches = cmd(page, cmdName, opts);
  for (let index = 0; index < await matches.count(); index++) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click({ timeout });
      return;
    }
  }
  const candidate = matches.first();
  await candidate.evaluate((element) => {
    const details = element.closest("details") as HTMLDetailsElement | null;
    if (details) details.open = true;
  });
  await candidate.click({ timeout });
}

export async function acceptConfirm(page: Page, timeout = 5000): Promise<string> {
  const dialog = page.locator("#dlg-confirm[open]");
  await dialog.waitFor({ state: "visible", timeout });
  const message = await dialog.innerText();
  await dialog.locator('button[type="submit"]').click({ timeout });
  await page.locator("#dlg-confirm").waitFor({ state: "hidden", timeout });
  return message;
}

export async function dismissConfirm(page: Page, timeout = 5000): Promise<string> {
  const dialog = page.locator("#dlg-confirm[open]");
  await dialog.waitFor({ state: "visible", timeout });
  const message = await dialog.innerText();
  await dialog.locator('[data-cmd="close-dialog"]').click({ timeout });
  await page.locator("#dlg-confirm").waitFor({ state: "hidden", timeout });
  return message;
}

export async function openCardMenu(card: Locator): Promise<void> {
  const menu = card.locator("details.card-menu").first();
  if (await menu.count()) {
    await menu.evaluate((element: HTMLDetailsElement) => {
      element.open = true;
    });
  }
}

export async function clickCardAction(
  card: Locator,
  action: string,
  timeout = 5000,
): Promise<void> {
  const target = card.locator(`[data-action="${action}"]`).first();
  if (!await target.isVisible()) await openCardMenu(card);
  await target.click({ timeout });
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
