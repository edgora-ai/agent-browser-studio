"""End-to-end example: connect to a running controller, inspect health,
create a managed Chromium profile, launch and stop it, and report team state.
Start the controller first:

    AGENT_BROWSER_API_TOKEN=my-token npx electron . --headless

then run this script from the repo root:

    python3 sdk/python/example.py --base-url http://127.0.0.1:26582 --token my-token
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_browser_client import AgentBrowserClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:26582")
    parser.add_argument("--token", default="my-token")
    parser.add_argument("--dry-run", action="store_true", help="only query, do not create/launch")
    args = parser.parse_args()

    client = AgentBrowserClient(args.base_url, args.token)
    health = client.health()
    print("health:", health)

    if args.dry_run:
        return 0

    profile = client.create_profile("python-sdk-demo", platform="windows", fingerprint_seed=4242)
    dir_id = profile["dirId"]
    print("created profile:", dir_id)

    try:
        launch = client.launch_profile(dir_id)
        print("launched:", launch)
        time.sleep(2)
        st = client.profile_status(dir_id)
        print("status:", st)
    finally:
        stop = client.stop_profile(dir_id)
        print("stopped:", stop)

    team = client.team_status()
    print("team:", team)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

