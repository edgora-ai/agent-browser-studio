// Seeds legacy default-session renderer storage (theme / language / wizard
// state) into a target user-data dir, exactly as an upgrade from before the
// UI-storage partition (Slice 58) would have left it. Launched standalone:
//
//   electron seed-legacy-storage.mjs --user-data-dir=<dir>
//
// Writes through the SAME file:// page the app's migration window loads
// (dist/renderer/storage-migrate.html), so the origin matches what
// migrateLegacyRendererStorage reads.
import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEGACY_VALUES = {
  "agent-browser-studio-theme": "dark",
  "cloak-theme": "dark",
  "agent-browser-studio-language": "zh-CN",
  "cloak-lite-language": "zh-CN",
  "agent-browser-studio-wizard-dismissed": "1",
  "cloak-wizard-dismissed": "1",
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const page = path.join(__dirname, "..", "..", "..", "dist", "renderer", "storage-migrate.html");
  await win.loadFile(page);
  const serialized = JSON.stringify(LEGACY_VALUES);
  const count = await win.webContents.executeJavaScript(
    "(() => { const v = " + serialized +
    "; for (const k of Object.keys(v)) { localStorage.setItem(k, v[k]); } return localStorage.length; })()",
  );
  console.log("seed-legacy-storage: wrote " + count + " keys to the default session");
  win.destroy();
  app.exit(0);
});

setTimeout(() => {
  console.error("seed-legacy-storage: timed out");
  app.exit(2);
}, 30000).unref();
