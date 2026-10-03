#!/usr/bin/env python3
"""Two-way sync between the vault's todo note and its copy on GitHub.

The phone app reads and writes the file on GitHub's `main` branch. This
keeps the Mac's working copy in step with it, whatever branch the vault has
checked out, using the GitHub API (via `gh`) rather than git pull/push.

A copy of the last content both sides agreed on (the merge base) tells us
who changed what since then:
  only the Mac changed it   -> upload it
  only GitHub changed it    -> write it into the vault
  both changed it           -> three-way merge; clashing lines keep both
                               versions, so nothing is ever lost

Run it once to sync; launchd runs it every minute and whenever the file is
saved. Settings come from environment variables (see DEFAULTS).
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULTS = {
    "TODO_FILE": None,  # e.g. ~/Vault/Todo.md
    "TODO_REPO": None,  # e.g. owner/vault
    "TODO_BRANCH": "main",
    "TODO_PATH": "Todo-Main.md",
    "TODO_STATE": "~/.local/state/todo-sync",
    "GH": "gh",
}
SETTLE_SECONDS = 4  # Obsidian autosaves while you type; wait for a pause before uploading
POLL_SECONDS = 50  # skip the network when nothing changed locally and we checked this recently


def env(key):
    value = os.environ.get(key, DEFAULTS[key])
    if value is None:
        sys.exit(f"{key} is not set (see mac/config.example.env)")
    return os.path.expanduser(value)


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


class GitHubFile:
    """One file on GitHub through `gh api`, which supplies the auth."""

    def __init__(self, repo, path, branch, gh="gh"):
        self.url = f"repos/{repo}/contents/{path}"
        self.branch = branch
        self.gh = gh

    def _api(self, *args, body=None):
        r = subprocess.run(
            [self.gh, "api", *args],
            input=json.dumps(body) if body else None,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip())
        return json.loads(r.stdout)

    def get(self):
        j = self._api(f"{self.url}?ref={self.branch}")
        return base64.b64decode(j["content"]).decode("utf-8"), j["sha"]

    def put(self, text, sha, message):
        body = {
            "message": message,
            "content": base64.b64encode(text.encode("utf-8")).decode(),
            "sha": sha,
            "branch": self.branch,
        }
        return self._api("-X", "PUT", self.url, "--input", "-", body=body)["content"]["sha"]


def read(path):
    return path.read_bytes().decode("utf-8")  # bytes, so CRLF and trailing newlines survive


def write(path, text):
    path.write_bytes(text.encode("utf-8"))


def merge3(local, base, remote):
    with tempfile.TemporaryDirectory() as d:
        files = []
        for name, text in (("local", local), ("base", base), ("remote", remote)):
            p = Path(d, name)
            write(p, text)
            files.append(str(p))
        # --union: where both sides changed the same lines, keep both instead of conflict markers.
        r = subprocess.run(["git", "merge-file", "-p", "--union", *files], capture_output=True)
        return r.stdout.decode("utf-8")


def wait_until_settled(path):
    for _ in range(10):
        age = time.time() - path.stat().st_mtime
        if age >= SETTLE_SECONDS:
            return
        time.sleep(SETTLE_SECONDS - age + 0.2)


def sync(file, state, remote, init=None):
    """One sync pass. Returns what happened, for logging and tests."""
    state.mkdir(parents=True, exist_ok=True)
    base_file = state / "base.md"
    checked_file = state / "last-check"

    wait_until_settled(file)
    local = read(file)
    base = read(base_file) if base_file.exists() else None

    # Called on every save of any kind; only touch the network when it can matter.
    if init is None and local == base and checked_file.exists():
        if time.time() - checked_file.stat().st_mtime < POLL_SECONDS:
            return "idle"

    text, sha = remote.get()
    checked_file.touch()

    if local == text:
        result = "in sync"
        new_base = local
    elif init == "remote" or (base is not None and local == base):
        if read(file) != local:
            return "busy"  # saved again while we were fetching; the next run merges it
        write(file, text)
        result, new_base = "pulled", text
    elif init == "local" or (base is not None and text == base):
        remote.put(local, sha, "todo: sync from Mac")
        result, new_base = "pushed", local
    elif base is None:
        raise SystemExit(
            "The vault copy and GitHub copy differ and there is no sync history yet.\n"
            "Run once with --init local (keep the Mac's) or --init remote (keep GitHub's)."
        )
    else:
        merged = merge3(local, base, text)
        if read(file) != local:
            return "busy"
        write(file, merged)
        if merged != text:
            remote.put(merged, sha, "todo: merge Mac and phone edits")
        result, new_base = "merged", merged

    if base != new_base:
        write(base_file, new_base)
    return result


def main(argv):
    init = None
    if len(argv) == 3 and argv[1] == "--init" and argv[2] in ("local", "remote"):
        init = argv[2]
    elif len(argv) != 1:
        sys.exit(f"usage: {argv[0]} [--init local|remote]")

    file = Path(env("TODO_FILE"))
    if not file.exists():
        sys.exit(f"{file} not found")
    remote = GitHubFile(env("TODO_REPO"), env("TODO_PATH"), env("TODO_BRANCH"), env("GH"))
    try:
        result = sync(file, Path(env("TODO_STATE")), remote, init)
    except RuntimeError as e:
        # Offline, or GitHub rejected a write because the phone just saved: the next run retries.
        log(f"skipped: {e}")
        return
    if result not in ("idle", "in sync"):
        log(result)


if __name__ == "__main__":
    main(sys.argv)
