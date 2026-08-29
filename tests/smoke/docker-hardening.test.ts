// Docker hardening contract (review item AR-8 / acceptance G1):
// the container must expose both surfaces (REST 26582 + MCP 26581), run as a
// non-root user, keep the data volume on that user's home, and document the
// container-constraint --no-sandbox honestly instead of silently shipping it.
// File-level assertions: a real `docker build` needs a Docker host and is
// covered by the engine-verify CI workflow.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");

describe("Docker hardening contract", () => {
  const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(REPO, "docker-compose.yml"), "utf8");

  it("exposes both the REST (26582) and MCP (26581) ports", () => {
    expect(dockerfile).toMatch(/^EXPOSE 26582 26581$/m);
    expect(compose).toContain('"26582:26582"');
    expect(compose).toContain('"26581:26581"');
  });

  it("runs the container as a non-root user", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    // compose must not override the user back to root
    expect(compose).not.toMatch(/^\s*user:\s*root/m);
  });

  it("keeps the data volume on the non-root user's home", () => {
    expect(compose).toContain("/home/node/.config/agent-browser-studio");
    expect(compose).not.toContain("/root/.config/agent-browser-studio");
  });

  it("documents --no-sandbox as a container constraint, not a silent default", () => {
    expect(dockerfile).toContain("--no-sandbox");
    expect(dockerfile).toMatch(/--no-sandbox.*(?:constraint|user namespace|namespace)/is);
  });
});
