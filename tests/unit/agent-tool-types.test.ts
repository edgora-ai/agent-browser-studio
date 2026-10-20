import { expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Read-only semantic validation through the approved isolated test runner.
// This emits no dist files and does not change tsconfig or coverage policy.
it("typechecks Task49-owned production and test files with the real project options", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const owned = [
    "src/main/services/local-agent.ts",
    "src/main/services/agent/tool-outcome.ts",
    "src/main/services/agent/desktop-chat.ts",
    "tests/unit/agent-tool-outcomes.test.ts",
    "tests/unit/agent-tool-local.test.ts",
    "tests/unit/agent-tool-browser.test.ts",
    "tests/unit/agent-tool-types.test.ts",
  ].map((file) => path.join(root, file));
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  const program = ts.createProgram([...parsed.fileNames, ...owned], { ...parsed.options, noEmit: true, rootDir: root });
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  const ownedErrors = errors.filter((diagnostic) => !diagnostic.file || owned.includes(path.resolve(diagnostic.file.fileName)));
  const display = (diagnostic: ts.Diagnostic) => {
    const location = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return `${diagnostic.file ? path.relative(root, diagnostic.file.fileName) : "project"}${location ? `:${location.line + 1}:${location.character + 1}` : ""} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  };
  console.log(`Task49 semantic diagnostics: owned=${ownedErrors.length}; outside-owned=${errors.length - ownedErrors.length}`);
  if (errors.length > ownedErrors.length) console.log(errors.filter((diagnostic) => !ownedErrors.includes(diagnostic)).map(display).join("\n"));
  expect(ownedErrors.map(display)).toEqual([]);
}, 30_000);
