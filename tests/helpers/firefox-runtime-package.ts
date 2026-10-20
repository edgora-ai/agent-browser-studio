import * as fs from "node:fs";
import * as path from "node:path";

// Discovery tests inject these parsed records at the plutil boundary. The
// runtime-package tests separately exercise real XML/binary plist conversion.
const plists = new Map<string, Record<string, unknown>>();
export const FIREFOX_HELPER_APPS = ["plugin-container.app", "gpu-helper.app", "gpu-process.app", "media-plugin-helper.app"];

export function writeFirefoxFixturePlist(file: string, value: Record<string, unknown>): void {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const entries = Object.entries(value).map(([key, entry]) =>
    `<key>${escape(key)}</key><string>${escape(String(entry))}</string>`).join("");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0"?><plist version="1.0"><dict>${entries}</dict></plist>`);
  plists.set(file, value);
}

export function firefoxFixturePlistJson(args: readonly string[]): string {
  const file = args[args.length - 1];
  const value = plists.get(file);
  if (!value || !fs.lstatSync(file).isFile()) throw new Error(`Unowned plist fixture: ${file}`);
  return JSON.stringify(value);
}

export function writeFirefoxRuntimeFixture(binary: string, version: string): void {
  const contents = path.dirname(path.dirname(binary));
  writeFirefoxFixturePlist(path.join(contents, "Info.plist"), {
    CFBundleShortVersionString: version, CFBundleVersion: version,
  });
  for (const helper of FIREFOX_HELPER_APPS) {
    writeFirefoxFixturePlist(path.join(contents, "MacOS", helper, "Contents", "Info.plist"), {});
  }
  for (const relative of ["omni.ja", "browser/omni.ja"]) {
    const file = path.join(contents, "Resources", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Deliberately not a ZIP: this fixture proves nonempty-file/layout checks,
    // not omnijar integrity. Optimized Mozilla archives need not start with PK.
    fs.writeFileSync(file, "nonempty static resource fixture");
  }
}
