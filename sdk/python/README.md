# Python SDK

A minimal, dependency-free REST client for Agent Browser Studio's loopback
control API. It works identically against the desktop app and the
`--headless` server mode, which makes it a good base for automation,
CI pipelines and Docker deployments.

## Quick start

Start the controller (GUI or headless):

    AGENT_BROWSER_API_TOKEN=my-token npx electron . --headless

Run the example:

    python3 sdk/python/example.py --base-url http://127.0.0.1:26582 --token my-token

## Client

```python
from agent_browser_client import AgentBrowserClient

client = AgentBrowserClient("http://127.0.0.1:26582", token="my-token")

print(client.health())                 # mode, version, profile count, uptime
profiles = client.list_profiles()
p = client.create_profile("campaign-1", platform="windows", fingerprint_seed=8801)
client.launch_profile(p["dirId"])
client.stop_profile(p["dirId"])
client.team_status()                   # workspace RBAC roster
```

The client covers: `health` / `version` / `openapi`, profiles
(list/get/create/delete/launch/stop/status), proxies, team workspace RBAC,
DRM status, automation rules, runs and jobs. Every method returns the parsed
JSON body; non-2xx responses raise `AgentBrowserError`.

## Server mode

See `README.md` → *Server mode & Docker* for the `--headless` flag,
the Dockerfile and compose example. JavaScript/.NET consumers can use the
same endpoints directly from `/openapi.json`.

