# Contributing

Thanks for considering a contribution to Agent Browser Studio.

## Development Setup

```bash
npm install
npm run build
npm test
```

For targeted tests:

```bash
npx vitest run tests/unit/sync-service.test.ts
npm run build
npx vitest run -c vitest.config.e2e.ts tests/e2e/j34-credential-vault.test.ts
```

E2E tests use generated data under `tests/e2e/userdata/`; do not commit that directory.

## Code Guidelines

- Follow existing TypeScript and renderer JavaScript style.
- Prefer small service → IPC → preload → renderer slices with tests.
- Keep Electron renderer code sandbox-compatible.
- Add tests for data persistence, IPC behavior, and security-sensitive paths.
- Avoid empty `catch {}` blocks in core logic; surface meaningful errors.
- Do not add hard-coded localhost endpoints, live API keys, credentials, or secret-shaped test tokens.

## Security Requirements

Security-sensitive changes should include adversarial considerations for:

- Path traversal and archive extraction
- Prototype pollution and unsafe JSON handling
- Shell/process execution
- Prompt injection and tool authorization
- Secret redaction in IPC, logs, exports, sync, and test fixtures
- Authentication and loopback-only service exposure

## Documentation Requirements

When adding user-visible capabilities, update the README and relevant docs. For features that process cookies, credentials, profile state, sync data, or external APIs, update privacy/security notes as needed.

## Pull Requests

Before opening a pull request:

1. Run `npm run build`.
2. Run relevant unit and E2E tests.
3. Check `git status --short --ignored` for generated local data.
4. Run a secret scan or at least grep for common secret prefixes.
5. Confirm no private data, local config, screenshots, audit logs, sqlite databases, or real credentials are included.
