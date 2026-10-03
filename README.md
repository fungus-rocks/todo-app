# Todo

A small installable web app for one Obsidian todo note that lives in a GitHub repo.
Check things off, add and edit todos, and dictate new ones from any phone or computer.
Every change goes back into the same Markdown file Obsidian shows.

```
 iPhone / any browser                 GitHub (private vault repo)              Mac
┌──────────────────────┐   contents   ┌──────────────────────────┐   gh api   ┌─────────────────────────┐
│ this app (PWA)       │ ───── API ──▶│ main:Todo-Main.md        │◀────────── │ mac/todo_sync.py        │
│ token in localStorage│◀──────────── │ (single source of truth) │ ─────────▶ │ launchd: every 60s +    │
└──────────────────────┘              └──────────────────────────┘            │ on save → vault file    │
                                                                              └─────────────────────────┘
```

- **No server.** The page is static (GitHub Pages); the browser calls the GitHub API
  directly with a fine-grained token that can only touch the one repo.
- **Edits are operations, not file overwrites.** Each tap becomes an op such as
  "check off *X* in section *Y*". Saving fetches the latest file, replays the
  pending ops onto it, and writes with that file's `sha`. If another device saved
  in between, GitHub refuses with 409 and the app fetches and replays again.
- **Only touched lines change.** Headings, prose, wikilinks, frontmatter and tab
  indentation pass through byte-for-byte.
- **Offline is fine.** Pending ops are kept in `localStorage` and sent on next open.
- **Voice.** The mic button uses the browser's speech recognition where it exists
  (hold it to switch English / 中文). Where it doesn't, the app falls back to the
  keyboard's dictation mic.

## Phone setup

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   *Repository access → Only select repositories →* your vault;
   *Permissions → Contents → Read and write*.
2. Open the app in Safari → Share → **Add to Home Screen**, then open it from the home screen.
3. Tap **Connect GitHub**, paste the token, enter `owner/repo` and the file path.

Home-screen apps on iOS keep their own storage, separate from Safari, so connect
from the home-screen icon.

### Siri / Action Button capture

Create a Shortcut with two actions:

1. **Dictate Text**
2. **Open URLs** → `https://<your-pages-url>/?add=` + *Dictated Text*
   (optionally `&section=Personal`)

Shortcuts opens these links in Safari, so connect once in Safari too.

## Mac setup

`mac/todo_sync.py` keeps the vault file and GitHub `main` in step through the
GitHub API, independent of whichever branch the vault has checked out. It keeps
the last agreed content as a merge base: one-sided changes are copied across,
and two-sided changes go through `git merge-file --union`, which keeps both
versions of a clashing line rather than dropping one.

```sh
gh auth login                 # once
mac/install.sh                # installs a launchd agent (every 60s + on save)
mac/install.sh uninstall
tail -f ~/Library/Logs/todo-sync.log
```

Settings via env vars: `TODO_FILE`, `TODO_REPO`, `TODO_BRANCH`, `TODO_PATH`.

## Development

```sh
python3 -m http.server 8765   # then open http://localhost:8765
npm test                      # parser + sync engine (node:test)
cd mac && python3 -m unittest # Mac sync
```
