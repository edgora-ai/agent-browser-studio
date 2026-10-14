import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const text = fs.readFileSync(new URL("../../scripts/visual-dialogs.mjs", import.meta.url), "utf8");
const source = ts.createSourceFile("visual-dialogs.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const themeLoop = source.statements.find((node): node is ts.ForOfStatement =>
  ts.isForOfStatement(node) && node.expression.getText(source) === "THEMES");
if (!themeLoop || !ts.isBlock(themeLoop.statement)) throw new Error("Dialog theme analysis loop unavailable");
const dialogLoop = themeLoop.statement.statements.find((node): node is ts.ForOfStatement =>
  ts.isForOfStatement(node) && node.expression.getText(source) === "DIALOGS");
if (!dialogLoop) throw new Error("Dialog findings analysis loop unavailable");
const declarations = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const constants = ["GARBAGE", "RAW_KEY"].map(name => {
  const declaration = declarations.find(node => ts.isIdentifier(node.name) && node.name.text === name);
  if (!declaration?.initializer) throw new Error(`Dialog analysis constant unavailable: ${name}`);
  return `const ${name} = ${declaration.initializer.getText(source)};`;
}).join("\n");
const script = new vm.Script(`${constants}\n${dialogLoop.getText(source)}`);

type Result = { open?: boolean; text?: string; overflow?: number; unavailable?: string; didNotOpen?: boolean; threw?: string };
type Finding = { id: string; kind: string; detail: string };
const body = (text: string, overflow = 0): Result => ({ open: true, text, overflow });
function analyze(zh: Record<string, Result>, en: Record<string, Result>): Finding[] {
  const findings: Finding[] = [];
  script.runInNewContext({
    zh, en, findings, opened: 0, skipped: 0, theme: "light", THEMES: ["light"], tag: "",
    DIALOGS: [{ id: "first", cmd: "openFirst" }, { id: "later", cmd: "openLater" }],
  });
  return findings;
}

describe("dialog audit findings from the actual analysis loop", () => {
  it("reports unavailable English without crashing or dropping Chinese body findings", () => {
    const findings = analyze({ first: body("undefined\nmissing.dialog.key") }, { first: { unavailable: "command unavailable" } });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "first", kind: "unavailable-surface", detail: expect.stringContaining("en:") }),
      expect.objectContaining({ id: "first", kind: "garbage-text" }),
      expect.objectContaining({ id: "first", kind: "raw-key-leak" }),
    ]));
  });

  it("still audits English when Chinese is unavailable", () => {
    const findings = analyze({ first: { unavailable: "dialog unavailable" } }, { first: body("missing.dialog.key") });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unavailable-surface", detail: expect.stringContaining("zh:") }),
      expect.objectContaining({ kind: "raw-key-leak", detail: expect.stringContaining("[en]") }),
    ]));
  });

  it("continues to later dialogs when both locales are unavailable", () => {
    const findings = analyze({ first: { unavailable: "command unavailable" }, later: body("missing.later.key") },
      { first: { unavailable: "listener unavailable" }, later: body("Later content") });
    expect(findings.filter(finding => finding.kind === "unavailable-surface")).toHaveLength(2);
    expect(findings).toContainEqual(expect.objectContaining({ id: "later", kind: "raw-key-leak" }));
  });

  it("reports English commands that ran without opening", () => {
    expect(analyze({ first: body("正常内容") }, { first: { didNotOpen: true } }))
      .toContainEqual(expect.objectContaining({ kind: "did-not-open", detail: expect.stringContaining("en:") }));
  });

  it("reports opener errors without requiring a nonexistent body", () => {
    expect(analyze({ first: body("正常内容") }, { first: { threw: "controlled opener error" } }))
      .toContainEqual(expect.objectContaining({ kind: "opener-threw" }));
  });

  it("retains differential untranslated-copy checks when both locales open", () => {
    const copy = "This sentence is long enough to expose an untranslated dialog body.";
    expect(analyze({ first: body(copy) }, { first: body(copy) }))
      .toContainEqual(expect.objectContaining({ kind: "untranslated" }));
  });

  it("reports overflow in either opened locale", () => {
    expect(analyze({ first: body("正常内容") }, { first: body("Normal content", 2) }))
      .toContainEqual(expect.objectContaining({ kind: "cell-overflow", detail: expect.stringContaining("[en]") }));
  });

  it("does not invent findings for clean bilingual dialogs", () => {
    expect(analyze({ first: body("正常内容"), later: body("后续内容") },
      { first: body("Normal content"), later: body("Later content") })).toEqual([]);
  });
});

interface AccountRef { index: number; revision: string }
interface AccountView { ref: AccountRef; tags: string[]; profileIds: string[] }
interface AccountsApi {
  list(): Promise<AccountView[]>;
  get(index: number, ref?: AccountRef): Promise<AccountView | null>;
}
const mockScript = new vm.Script(fs.readFileSync(new URL("../../scripts/visual-mock.js", import.meta.url), "utf8"));
function accountsFixture(): AccountsApi {
  const window = {} as { agentBrowserAPI: { agent: { accounts: AccountsApi } } };
  mockScript.runInNewContext({ window });
  return window.agentBrowserAPI.agent.accounts;
}

describe("visual account read snapshots", () => {
  it("lists a displayed reference that the selected-account getter can read", async () => {
    const accounts = accountsFixture();
    const listed = await accounts.list();
    expect(listed).toHaveLength(3);
    expect(listed[0].ref).toEqual({ index: 0, revision: expect.any(String) });
    expect(listed[0].ref.revision).not.toBe("");
    expect(await accounts.get(0, listed[0].ref)).toEqual(listed[0]);
  });

  it("keeps list and get results detached from later reads", async () => {
    const accounts = accountsFixture();
    const before = await accounts.list();
    const selected = await accounts.get(0, before[0].ref);
    expect(selected).not.toBeNull();
    if (!selected) throw new Error("Selected fixture account missing");
    selected.tags.push("mutated returned view");
    selected.ref.revision = "mutated reference";
    expect(await accounts.list()).toEqual(before);
  });

  it("rejects missing or conflicting selected-account references", async () => {
    const accounts = accountsFixture();
    const listed = await accounts.list();
    await expect(accounts.get(0)).rejects.toMatchObject({ code: "ACCOUNT_REFERENCE_CONFLICT" });
    await expect(accounts.get(0, { index: 0, revision: "stale" })).rejects.toMatchObject({ code: "ACCOUNT_REFERENCE_CONFLICT" });
    await expect(accounts.get(1, listed[0].ref)).rejects.toMatchObject({ code: "ACCOUNT_REFERENCE_CONFLICT" });
  });
});
