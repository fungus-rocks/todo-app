import tempfile
import unittest
from pathlib import Path

import todo_sync
from todo_sync import sync

todo_sync.SETTLE_SECONDS = 0

NOTE = "## Home\n- [ ] Fix shelf\n- [ ] Buy curtain\n"


class FakeRemote:
    def __init__(self, text):
        self.text, self.version, self.commits = text, 1, []

    def get(self):
        return self.text, f"sha{self.version}"

    def put(self, text, sha, message):
        if sha != f"sha{self.version}":
            raise RuntimeError("409 conflict")
        self.text, self.version = text, self.version + 1
        self.commits.append(message)
        return f"sha{self.version}"


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.file = self.dir / "Todo-Main.md"
        self.state = self.dir / "state"
        self.file.write_text(NOTE)
        self.remote = FakeRemote(NOTE)
        self.assertEqual(self.run_sync(), "in sync")

    def run_sync(self, **kw):
        (self.state / "last-check").unlink(missing_ok=True)  # don't let the poll throttle hide work
        return sync(self.file, self.state, self.remote, **kw)

    def test_phone_edit_reaches_the_vault(self):
        self.remote.text = NOTE.replace("[ ] Fix shelf", "[x] Fix shelf")
        self.assertEqual(self.run_sync(), "pulled")
        self.assertEqual(self.file.read_text(), self.remote.text)

    def test_mac_edit_reaches_github(self):
        self.file.write_text(NOTE + "- [ ] From Obsidian\n")
        self.assertEqual(self.run_sync(), "pushed")
        self.assertEqual(self.remote.text, NOTE + "- [ ] From Obsidian\n")

    def test_both_edited_different_lines_merge_cleanly(self):
        self.file.write_text(NOTE + "- [ ] From Obsidian\n")
        self.remote.text = NOTE.replace("[ ] Fix shelf", "[x] Fix shelf")
        self.assertEqual(self.run_sync(), "merged")
        expected = "## Home\n- [x] Fix shelf\n- [ ] Buy curtain\n- [ ] From Obsidian\n"
        self.assertEqual(self.file.read_text(), expected)
        self.assertEqual(self.remote.text, expected)

    def test_same_line_clash_keeps_both_versions(self):
        self.file.write_text(NOTE.replace("Buy curtain", "Buy blue curtain"))
        self.remote.text = NOTE.replace("[ ] Buy curtain", "[x] Buy curtain")
        self.assertEqual(self.run_sync(), "merged")
        text = self.file.read_text()
        self.assertIn("Buy blue curtain", text)
        self.assertIn("[x] Buy curtain", text)

    def test_no_history_and_different_refuses_to_guess(self):
        (self.state / "base.md").unlink()
        self.remote.text = NOTE + "- [ ] other\n"
        with self.assertRaises(SystemExit):
            self.run_sync()
        self.assertEqual(self.run_sync(init="remote"), "pulled")

    def test_unchanged_file_skips_the_network_between_polls(self):
        calls = []
        real_get = self.remote.get
        self.remote.get = lambda: calls.append(1) or real_get()
        sync(self.file, self.state, self.remote)
        sync(self.file, self.state, self.remote)
        self.assertEqual(len(calls), 0)

    def test_chinese_text_round_trips(self):
        self.remote.text = NOTE + "- [ ] 买牛奶\n"
        self.run_sync()
        self.assertEqual(self.file.read_bytes().decode("utf-8"), NOTE + "- [ ] 买牛奶\n")


if __name__ == "__main__":
    unittest.main()
