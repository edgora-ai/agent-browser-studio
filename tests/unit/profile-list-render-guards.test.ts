import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PROFILES_RENDERER = path.resolve(__dirname, "..", "..", "src", "renderer", "js", "app", "profiles.js");

describe("profile list render guards", () => {
  it("does not let an overlapping refresh leave the loading placeholder behind", () => {
    const source = fs.readFileSync(PROFILES_RENDERER, "utf8");
    expect(source).toContain('container.querySelectorAll(":scope > .profile-card")');
    expect(source).toContain("signature === lastRenderSignature && renderedSignature === signature");
    expect(source).not.toContain("if (signature === lastRenderSignature) {");
  });

  it("exposes the wired WebRTC diagnostics action in the profile card menu", () => {
    const source = fs.readFileSync(PROFILES_RENDERER, "utf8");
    expect(source).toContain('data-action="webrtc-diag"');
    expect(source).toContain('action === "webrtc-diag"');
  });
});
