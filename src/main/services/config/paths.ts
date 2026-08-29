import * as path from "node:path";
import { app } from "electron";
let _appDataDir: string | null = null;
let _configPath: string | null = null;
let _profilesDir: string | null = null;
function resolveAppDataDir(): string { if (!_appDataDir) _appDataDir = app.getPath("userData"); return _appDataDir; }
export function getAppDataDir(): string { return resolveAppDataDir(); }
export function getConfigPath(): string { if (!_configPath) _configPath = path.join(resolveAppDataDir(), "config.json"); return _configPath; }
export function getProfilesDir(): string { if (!_profilesDir) _profilesDir = path.join(resolveAppDataDir(), "profiles"); return _profilesDir; }
