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
