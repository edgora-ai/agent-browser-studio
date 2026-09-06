#!/usr/bin/env node
/**
 * Offline license minting tool (seller side, sale-90).
 *
 * Generates an ed25519 keypair once, then mints device-bound activation
 * codes: base64url(payloadJson) + "." + base64url(signature).
 *
 *   # 1. Generate a keypair (DO THIS ONCE, keep the private key secret):
 *   node scripts/mint-license.mjs --gen-key
 *   #    -> prints LICENSE_PUBLIC_KEY_B64 (embed via AGENT_BROWSER_LICENSE_PUBKEY
 *   #       at release time) and LICENSE_PRIVATE_KEY_B64 (seller only).
 *
 *   # 2. Mint a code for a buyer's device id:
 *   LICENSE_PRIVATE_KEY_B64=<priv> node scripts/mint-license.mjs --mint \
 *     --plan yearly --device <deviceId> --to "buyer-1" --days 365
 *
 *   # Lifetime (no expiry):
 *   LICENSE_PRIVATE_KEY_B64=<priv> node scripts/mint-license.mjs --mint \
 *     --plan lifetime --device <deviceId> --to "buyer-1"
 *
 * NEVER commit a private key. NEVER log minted codes beyond delivery.
 */
import { generateKeyPairSync, sign } from "node:crypto";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

if (process.argv.includes("--gen-key")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  console.log("LICENSE_PUBLIC_KEY_B64=" + pubDer.toString("base64"));
  console.log("LICENSE_PRIVATE_KEY_B64=" + privDer.toString("base64"));
  process.exit(0);
}

if (process.argv.includes("--mint")) {
  const privB64 = process.env.LICENSE_PRIVATE_KEY_B64 || "";
  if (!privB64) {
    console.error("error: set LICENSE_PRIVATE_KEY_B64 first");
    process.exit(2);
  }
  const plan = arg("--plan", "yearly");
  if (!["monthly", "yearly", "lifetime"].includes(plan)) {
    console.error("error: --plan must be monthly|yearly|lifetime");
    process.exit(2);
  }
  const deviceId = arg("--device", "");
  if (!deviceId) {
    console.error("error: --device <deviceId> is required");
    process.exit(2);
  }
  const licensedTo = arg("--to", "");
  const days = Number(arg("--days", plan === "monthly" ? "30" : "365"));
  const now = Date.now();
  const payload = {
    plan,
    licensedTo,
    expiresAt: plan === "lifetime" ? null : now + days * 24 * 60 * 60 * 1000,
    maxProfiles: null,
    deviceId,
    issuedAt: now,
    nonce: Math.random().toString(36).slice(2, 10),
  };
  const { createPrivateKey } = await import("node:crypto");
  const key = createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
  const body = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(body, "utf-8"), key);
  console.log(`${b64url(body)}.${b64url(sig)}`);
  process.exit(0);
}

console.error("usage: --gen-key | --mint --plan <p> --device <id> [--to <name>] [--days <n>]");
process.exit(2);
