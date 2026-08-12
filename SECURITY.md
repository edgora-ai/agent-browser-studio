# Security Policy

## Supported Versions

This project is pre-1.0 operational software. Security fixes are applied to the `main` branch and the latest published release artifacts when available.

## Reporting a Vulnerability

Please do not disclose vulnerabilities publicly until maintainers have had a reasonable chance to investigate and ship a fix.

Report security issues by opening a private security advisory on GitHub, or by contacting the maintainer through a private channel listed on the repository profile.

Include:

- Affected version or commit
- Operating system and Node/Electron versions
- Reproduction steps
- Impact assessment
- Any logs or screenshots with secrets removed

## Security Boundaries

Agent Browser Studio is a local desktop application. It handles sensitive local data including browser profile state, cookies, localStorage, proxy credentials, LLM API keys, sync credentials, audit logs, and agent traces.

Expected protections include:

- Renderer sandbox, context isolation, and no Node integration in the renderer
- Local config file permissions intended for the current OS user
- Secret redaction in IPC, UI, export, and sync-safe config paths
- OS-backed secret encryption for team-signed builds; local/ad-hoc macOS
  builds use an authenticated AES-256-GCM vault with a mode-0600 random key
- Loopback-only MCP server protected by a bearer token
- ZIP/archive validation before extension import or sync restore

Do not assume Agent Browser Studio protects data from malware, a compromised operating system account, malicious browser extensions, or a hostile local administrator.

## Out of Scope

- Reports requiring physical access to an already-unlocked machine
- Social engineering or phishing
- Denial-of-service attacks against public services
- Automated mass scanning of third-party infrastructure
- Issues in third-party services or websites automated by the user
