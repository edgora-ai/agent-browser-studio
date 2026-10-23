import { afterAll, test } from "vitest";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as vm from "node:vm";
import { createHash } from "node:crypto";

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
// Cache compilation, never contexts, returned values, handlers or IPC state.
// Each unchanged fixture call still executes the full module in a fresh context.
const scriptCache = new Map<string, vm.Script>();
let scriptHits = 0;
type ScriptOptions = vm.ScriptOptions & vm.RunningScriptInNewContextOptions;
function compiledScript(code: string, options: ScriptOptions = {}): vm.Script {
  if (options.importModuleDynamically) return new vm.Script(code, options);
  const key = createHash("sha256").update(code).update(JSON.stringify({
    filename: options.filename, lineOffset: options.lineOffset, columnOffset: options.columnOffset,
  })).digest("hex");
  let script = scriptCache.get(key);
  if (!script) { script = new vm.Script(code, options); scriptCache.set(key, script); }
  else scriptHits++;
  return script;
}
const fixtureVm = Object.create(vm);
Object.defineProperties(fixtureVm, {
  runInContext: { value(code: string, context: vm.Context, options: ScriptOptions = {}) {
    return compiledScript(code, options).runInContext(context, options);
  } },
  runInNewContext: { value(code: string, context: vm.Context = {}, options: ScriptOptions = {}) {
    return compiledScript(code, options).runInNewContext(context, options);
  } },
});
const fixtureFile = createRequire(import.meta.url).resolve("./renderer-skill-card-i18n.fixture.cjs");
const realRequire = createRequire(fixtureFile);
const fixtureRequire = Object.assign((id: string): any => id === "node:vm" || id === "vm" ? fixtureVm : realRequire(id), realRequire);
const fixtureModule = { exports: {} as FixtureModule };
// The existing CJS source is unchanged; only its VM compilation boundary is cached.
vm.compileFunction(fs.readFileSync(fixtureFile, "utf8"), ["exports", "require", "module", "__filename", "__dirname"], { filename: fixtureFile })(
  fixtureModule.exports, fixtureRequire, fixtureModule, fixtureFile, path.dirname(fixtureFile),
);
const HANDLER_CASE = "real page/marketplace handlers dispatch untouched IDs and mutate only IPC-boundary fixture state";
const register: RegisterTest = (name, body) => {
  // This case executes 96 fresh DOM/VM fixtures, not one renderer action.
  // Bound the full CPU workload with headroom for V8 coverage on shared runners.
  test(name, body, name === HANDLER_CASE ? 15_000 : undefined);
};
afterAll(() => {
  console.info(`[skill-card script cache] outputs=${scriptCache.size}, hits=${scriptHits}`);
  if (scriptCache.size === 0 || scriptHits === 0) throw new Error("Skill-card script cache was not exercised by the actual handler fixture");
});
fixtureModule.exports.registerSkillCardI18nTests(register, {
  root,
  helperRoot: process.env.SKILL_CARD_HELPER_ROOT,
  // Optional pre-patch archive only; all positive assertions run without it.
  baselineRoot: process.env.SKILL_CARD_REFERENCE_ROOT,
});
