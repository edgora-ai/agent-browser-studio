# Privacy Notice

Agent Browser Studio is designed as a self-hosted local desktop application. The project does not include a hosted backend operated by the maintainers.

## Data Stored Locally

Depending on how you use the app, Agent Browser Studio may store or process:

- Managed Chromium profile metadata and profile directories
- Cookies, localStorage, preferences, bookmarks, and extension state
- Proxy hostnames, ports, usernames, and encrypted or redacted credential metadata
- Account records and local notes
- LLM provider configuration and encrypted API keys
- Agent conversations, tool calls, screenshots, and run traces
- Automation rules, durable jobs, and audit logs
- Sync configuration and remote object metadata

Local runtime data is ignored by `.gitignore`, but you remain responsible for excluding user data from commits, backups, screenshots, bug reports, and exported bundles.

## Data Sent to Third Parties

Agent Browser Studio may send data to third parties only when you configure or trigger those integrations, for example:

- LLM prompts, tool context, webpage text, and agent conversation history may be sent to the selected LLM provider.
- Proxy detection requests may contact external IP/geolocation services.
- Remote sync may upload selected config, cookies, localStorage, bookmarks, and preferences to your configured S3-compatible storage.
- Browser automation interacts with websites that you visit in managed Chromium profiles.

Review provider terms and privacy policies before connecting API keys, proxies, or sync buckets.

## Exports and Logs

Data export and audit features are intended for debugging, evaluation, and governance. Exports are designed to redact known secret fields, but they may still contain operational metadata, profile names, tags, URLs, account labels, timing information, and non-secret identifiers. Treat exported files as sensitive.

## User Responsibility

You are responsible for:

- Obtaining consent and legal authority for any accounts, websites, data, or systems you automate
- Protecting local user data and backups
- Rotating keys if local data or exports are shared accidentally
- Complying with website terms, platform policies, privacy laws, and data-protection requirements
