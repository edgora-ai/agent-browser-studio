"""End-to-end agent example for the Python SDK (Slice 63).

Demonstrates the agent surface added in Slice 62: LLM config,
conversations, one-shot and tool-calling chat, run traces, the SQLite
store and approvals.

Start the controller first:

    AGENT_BROWSER_API_TOKEN=my-token npx electron . --headless

then run from the repo root:

    python3 sdk/python/example_agent.py --base-url http://127.0.0.1:26582 --token my-token

Chat calls need a saved LLM config; pass --llm-api-key (and optionally
--llm-api-url / --llm-model) to save one, or they are skipped when the
controller already has a config.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_browser_client import AgentBrowserClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:26582")
    parser.add_argument("--token", default="my-token")
    parser.add_argument("--llm-api-key", default="", help="save an LLM config with this key")
    parser.add_argument("--llm-api-url", default="https://api.openai.com/v1/chat/completions")
    parser.add_argument("--llm-model", default="gpt-4o-mini")
    args = parser.parse_args()

    client = AgentBrowserClient(args.base_url, args.token)

    # 1. LLM config — only saved when a key is provided.
    current = client.llm_config()
    cfg = current.get("config")
    print("llm config     :", cfg if cfg else "(none)")
    if args.llm_api_key:
        saved = client.save_llm_config(
            provider="openai" if "openai.com" in args.llm_api_url else "custom",
            api_key=args.llm_api_key,
            api_url=args.llm_api_url,
            model=args.llm_model,
        )
        print("llm saved      :", saved["success"], "hasApiKey=", saved["config"]["hasApiKey"])

    # 2. One-shot chat (no tools, no persistence).
    if args.llm_api_key or cfg:
        simple = client.chat_simple([{"role": "user", "content": "Say hello in one short sentence."}])
        print("chat-simple    :", simple["reply"])

    # 3. Conversation-scoped tool-calling chat + run trace.
    if args.llm_api_key or cfg:
        conv = client.create_conversation("python-sdk-agent-demo")
        conv_id = conv["conversation"]["id"]
        print("conversation   :", conv_id)
        chat = client.chat(conv_id, "Set the variable demo_probe to ok, then summarize in one sentence.")
        print("chat           :", chat.get("reply"))
        print("tool calls     :", chat.get("toolCalls", []))
        run_id = chat.get("runId")
        if run_id:
            run = client.agent_run(run_id)
            print("run            :", run["run"]["status"], "steps=", len(run["run"].get("steps", [])))
        history = client.get_conversation(conv_id)
        print("messages       :", len(history["conversation"]["messages"]))
        client.delete_conversation(conv_id)

    # 4. Read-only agent surfaces (always available).
    runs = client.agent_runs(limit=5)
    print("runs           :", len(runs))
    tables = client.db_tables()
    print("db tables      :", ", ".join(t["name"] for t in tables))
    approvals = client.pending_approvals()
    print("approvals      :", len(approvals))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

