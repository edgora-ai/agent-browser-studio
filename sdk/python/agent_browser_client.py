"""Agent Browser Studio — minimal REST client.

Talks to the controller's loopback REST API (GUI or --headless server mode).
Every method maps 1:1 to an endpoint in /openapi.json; profiles are the
primary managed-Chromium surface.

Example:
    client = AgentBrowserClient("http://127.0.0.1:26582", token="<AGENT_BROWSER_API_TOKEN>")
    client.health()
    profile = client.create_profile(name="py", platform="windows", fingerprint_seed=4242)
    client.launch_profile(profile["dirId"])
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Optional


class AgentBrowserError(RuntimeError):
    """Raised when the controller returns a non-2xx response."""


class AgentBrowserClient:
    def __init__(self, base_url: str, token: str, timeout: float = 15.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    # ── low-level ──────────────────────────────────────────────────────────
    def request(self, method: str, path: str, body: Any = None, auth: bool = True) -> Any:
        url = self.base_url + path
        data = None
        headers: dict[str, str] = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        if auth:
            headers["authorization"] = "Bearer " + self.token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                if not raw:
                    return {}
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                pass
            raise AgentBrowserError(f"{method} {path} -> {exc.code}: {detail[:500]}") from exc

    def get(self, path: str, auth: bool = True) -> Any:
        return self.request("GET", path, auth=auth)

    def post(self, path: str, body: Any = None, auth: bool = True) -> Any:
        return self.request("POST", path, body, auth=auth)

    def delete(self, path: str, auth: bool = True) -> Any:
        return self.request("DELETE", path, auth=auth)

    def put(self, path: str, body: Any = None, auth: bool = True) -> Any:
        return self.request("PUT", path, body, auth=auth)

    def patch(self, path: str, body: Any = None, auth: bool = True) -> Any:
        return self.request("PATCH", path, body, auth=auth)

    # ── system ─────────────────────────────────────────────────────────────
    def health(self) -> dict[str, Any]:
        return self.get("/health", auth=False)

    def version(self) -> dict[str, Any]:
        return self.get("/version")

    def openapi(self) -> dict[str, Any]:
        return self.get("/openapi.json", auth=False)

    # ── profiles ───────────────────────────────────────────────────────────
    def list_profiles(self) -> list[dict[str, Any]]:
        return self.get("/api/profiles").get("profiles", [])

    def get_profile(self, dir_id: str) -> dict[str, Any]:
        return self.get(f"/api/profiles/{dir_id}")

    def create_profile(self, name: str, platform: str = "windows",
                       fingerprint_seed: Optional[int] = None, **opts: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": name, "platform": platform}
        if fingerprint_seed is not None:
            payload["fingerprintSeed"] = fingerprint_seed
        payload.update(opts)
        return self.post("/api/profiles", payload)

    def delete_profile(self, dir_id: str) -> dict[str, Any]:
        return self.delete(f"/api/profiles/{dir_id}")

    def launch_profile(self, dir_id: str, headless: Optional[bool] = None) -> dict[str, Any]:
        """Launch a profile. Pass headless=True/False to override the server default;
        omit to keep the controller's default (GUI)."""
        body = {} if headless is None else {"headless": bool(headless)}
        return self.post(f"/api/profiles/{dir_id}/launch", body)

    def stop_profile(self, dir_id: str) -> dict[str, Any]:
        return self.post(f"/api/profiles/{dir_id}/stop")

    def profile_status(self, dir_id: str) -> dict[str, Any]:
        return self.get(f"/api/profiles/{dir_id}/status")

    # ── proxies ────────────────────────────────────────────────────────────
    def list_proxies(self) -> list[dict[str, Any]]:
        return self.get("/api/proxies").get("proxies", [])

    def add_proxy(self, name: str, config: dict[str, Any]) -> dict[str, Any]:
        return self.post("/api/proxies", {"name": name, "config": config})

    def delete_proxy(self, name: str) -> dict[str, Any]:
        return self.delete("/api/proxies/" + name)

    # ── team workspace ─────────────────────────────────────────────────────
    def team_status(self) -> dict[str, Any]:
        return self.get("/api/team")

    def team_init(self, name: str) -> dict[str, Any]:
        return self.post("/api/team/init", {"name": name})

    def team_add_member(self, device_id: str, role: str, name: str = "") -> dict[str, Any]:
        return self.post("/api/team/members", {"deviceId": device_id, "name": name, "role": role})

    def team_remove_member(self, device_id: str) -> dict[str, Any]:
        return self.delete("/api/team/members/" + device_id)

    # ── DRM ────────────────────────────────────────────────────────────────
    def drm_status(self) -> dict[str, Any]:
        return self.get("/api/drm/status")

    def server_idle(self) -> dict[str, Any]:
        """Idle auto-stop policy + per-profile idle times (server/headless)."""
        return self.get("/api/server/idle")

    # ── automation / runs / jobs ───────────────────────────────────────────
    def automation_rules(self) -> list[dict[str, Any]]:
        return self.get("/api/automation/rules").get("rules", [])

    def runs(self, **query: Any) -> list[dict[str, Any]]:
        from urllib.parse import urlencode
        qs = ("?" + urlencode(query)) if query else ""
        return self.get("/api/runs" + qs).get("runs", [])

    def jobs(self, **query: Any) -> list[dict[str, Any]]:
        from urllib.parse import urlencode
        qs = ("?" + urlencode(query)) if query else ""
        return self.get("/api/jobs" + qs).get("jobs", [])

    # ── agent / LLM ───────────────────────────────────────────────────────
    def llm_config(self) -> dict[str, Any]:
        """Read the saved LLM config (API key redacted; hasApiKey boolean)."""
        return self.get("/api/agent/llm-config")

    def save_llm_config(self, provider: str, api_key: str,
                        api_url: Optional[str] = None, model: Optional[str] = None) -> dict[str, Any]:
        """Save the LLM config; the API key is encrypted at rest."""
        payload: dict[str, Any] = {"provider": provider, "apiKey": api_key}
        if api_url is not None:
            payload["apiUrl"] = api_url
        if model is not None:
            payload["model"] = model
        return self.put("/api/agent/llm-config", payload)

    # ── agent conversations ───────────────────────────────────────────────
    def list_conversations(self) -> list[dict[str, Any]]:
        return self.get("/api/agent/conversations").get("conversations", [])

    def create_conversation(self, title: Optional[str] = None) -> dict[str, Any]:
        body = {} if title is None else {"title": title}
        return self.post("/api/agent/conversations", body)

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        return self.get("/api/agent/conversations/" + conversation_id)

    def rename_conversation(self, conversation_id: str, title: str) -> dict[str, Any]:
        return self.patch("/api/agent/conversations/" + conversation_id, {"title": title})

    def delete_conversation(self, conversation_id: str) -> dict[str, Any]:
        return self.delete("/api/agent/conversations/" + conversation_id)

    # ── agent chat ────────────────────────────────────────────────────────
    def chat_simple(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        """One-shot chat without tools; messages are [{role, content}, ...]."""
        return self.post("/api/agent/chat-simple", {"messages": messages})

    def chat(self, conversation_id: str, message: str,
             timeout_ms: Optional[int] = None) -> dict[str, Any]:
        """Conversation-scoped tool-calling chat; returns {reply, toolCalls, runId}."""
        payload: dict[str, Any] = {"conversationId": conversation_id, "message": message}
        if timeout_ms is not None:
            payload["timeoutMs"] = int(timeout_ms)
        return self.post("/api/agent/chat", payload)

    # ── agent run traces ──────────────────────────────────────────────────
    def agent_runs(self, **query: Any) -> list[dict[str, Any]]:
        from urllib.parse import urlencode
        qs = ("?" + urlencode(query)) if query else ""
        return self.get("/api/agent/runs" + qs).get("runs", [])

    def agent_run(self, run_id: str) -> dict[str, Any]:
        return self.get("/api/agent/runs/" + run_id)

    def delete_agent_run(self, run_id: str) -> dict[str, Any]:
        return self.delete("/api/agent/runs/" + run_id)

    def clear_agent_runs(self) -> dict[str, Any]:
        return self.delete("/api/agent/runs")

    # ── agent SQLite store ────────────────────────────────────────────────
    def db_tables(self) -> list[dict[str, Any]]:
        return self.get("/api/agent/db/tables").get("tables", [])

    def db_table(self, table: str, limit: Optional[int] = None, offset: Optional[int] = None) -> dict[str, Any]:
        from urllib.parse import urlencode
        q: dict[str, str] = {}
        if limit is not None:
            q["limit"] = str(int(limit))
        if offset is not None:
            q["offset"] = str(int(offset))
        qs = ("?" + urlencode(q)) if q else ""
        return self.get("/api/agent/db/" + table + qs)

    def db_query(self, sql: str) -> dict[str, Any]:
        return self.post("/api/agent/db/query", {"sql": sql})

    def db_exec(self, sql: str) -> dict[str, Any]:
        return self.post("/api/agent/db/exec", {"sql": sql})

    # ── approval gate ─────────────────────────────────────────────────────
    def pending_approvals(self) -> list[dict[str, Any]]:
        return self.get("/api/agent/approvals").get("approvals", [])

    def resolve_approval(self, approval_id: str, decision: str) -> dict[str, Any]:
        return self.post("/api/agent/approvals/" + approval_id + "/resolve", {"decision": decision})

    # ── skills ─────────────────────────────────────────────────────────────
    def list_skills(self, filter_text: Optional[str] = None) -> list[dict[str, Any]]:
        from urllib.parse import urlencode
        qs = ("?" + urlencode({"filter": filter_text})) if filter_text else ""
        return self.get("/api/skills" + qs).get("skills", [])

    def install_skill(self, skill_id: str) -> dict[str, Any]:
        return self.post("/api/skills/" + skill_id + "/install")

    def delete_skill(self, skill_id: str) -> dict[str, Any]:
        return self.delete("/api/skills/" + skill_id)
