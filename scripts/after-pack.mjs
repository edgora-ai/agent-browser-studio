import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// electron-builder leaves the downloaded Electron bundle's stale ad-hoc
// signature in place when no Apple signing identity is installed. Modifying
// resources then makes that signature invalid and causes macOS Keychain to ask
// repeatedly. Give local builds a fresh, internally consistent ad-hoc
// signature. A configured Developer ID signature is applied by electron-builder
// after this hook and supersedes it.
//
// The bundle now embeds fully-built nested browsers (Chromium.app / Firefox.app)
// under Resources/native-browsers. Those keep their own code signatures
// untouched — recursive signing via --deep rewrites their Framework symlinks
// and hardlink structure and fails with
// "invalid destination for symbolic link in bundle", so the top-level app is
// signed single-layer here and verification stays non-recursive.
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productName = context.packager.appInfo.productFilename;
  const appId = context.packager.config.appId || "com.ahoo.agent-browser-studio";
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`macOS app bundle not found after pack: ${appPath}`);

  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    appId,
    appPath,
  ], { stdio: "inherit" });

  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    appPath,
  ], { stdio: "inherit" });
}
