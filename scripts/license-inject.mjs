#!/usr/bin/env node
/**
 * license:inject — embed the license public key into the packaged app.
 *
 * Reads AGENT_BROWSER_LICENSE_PUBKEY (base64 SPKI DER) and writes
 * dist/resources/license-pubkey.txt so getLicensePublicKeyB64() picks it up
 * at runtime. Runs as part of `npm run build` (after resources are copied).
 *
 * - Empty/missing env: writes nothing (trial-only build, same as before).
 * - Never prints the key. Validates base64 shape before writing.
 *
 * Usage:
 *   AGENT_BROWSER_LICENSE_PUBKEY=<b64> npm run build
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist", "resources", "license-pubkey.txt");

const b64 = (process.env.AGENT_BROWSER_LICENSE_PUBKEY || "").trim();
if (!b64) {
  console.log("license:inject: no public key in env — trial-only build");
  process.exit(0);
}
if (!/^[A-Za-z0-9+/=_-]+$/.test(b64) || Buffer.from(b64, "base64").length < 32) {
  console.error("license:inject: AGENT_BROWSER_LICENSE_PUBKEY does not look like base64 SPKI — refusing");
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, b64 + "\n", { mode: 0o644 });
console.log("license:inject: public key embedded");
