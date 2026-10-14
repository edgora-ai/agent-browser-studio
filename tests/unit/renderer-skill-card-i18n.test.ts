import { test } from "vitest";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Public Vitest registration; the CJS fixture never starts a nested runner.
type TestBody = () => void | Promise<void>;
type RegisterTest = (name: string, body: TestBody) => void;
interface FixtureOptions {
  root: string;
  helperRoot?: string;
  baselineRoot?: string;
}
interface FixtureModule {
  registerSkillCardI18nTests(register: RegisterTest, options: FixtureOptions): void;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = createRequire(import.meta.url)("./renderer-skill-card-i18n.fixture.cjs") as FixtureModule;
const register: RegisterTest = (name, body) => { test(name, body); };
fixture.registerSkillCardI18nTests(register, {
  root,
  helperRoot: process.env.SKILL_CARD_HELPER_ROOT,
  // Optional pre-patch archive only; all positive assertions run without it.
  baselineRoot: process.env.SKILL_CARD_REFERENCE_ROOT,
});
