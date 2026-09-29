---
name: kanban
description: "Work a repository's task board. The board is Markdown in the repository (.ai/kanban, committed): one folder per column, one card per task with its fields in front matter, ticket IDs (JIRA style, e.g. APP-12) for commit messages. Covers setting a board up, opening the dashboard (a page this skill ships, which the agent injects the board into and serves), applying the changes made on the dashboard, picking up queued work, moving cards, one verified commit per task, and the review/approval cycle. Use when the user says to work the board, pick up ready tasks, start or finish a task, open or show the board, asks what's next or how things stand, or asks for a board in a new repository."
---

# Kanban

A project's board is Markdown in the repository, under `.ai/kanban/`, committed with the work.
This skill holds no program: a ready-made CSS/JS framework and templates (`board/`), which
render the board in a browser, and these instructions. The agent keeps the files. It injects
them into the page, and applies what the user changes there.

## The board: `.ai/kanban/`

```
.ai/kanban/
  README.md            the board's status, for people reading the repository (see below)
  board.yml            name, ticket key, columns, fields, the new-card template
  <column>/            one folder per column, named by the column's id
    _<column>.md       the column's cards in order: a numbered list of links, top first
    012-password-reset-by-email.md
```

**board.yml** (start from `templates/board.yml`):

- `name` and `key`. The key gives the ticket IDs: card 13 is `KEY-13`.
- `columns`: `id` (the folder) and `title`.
- `fields`, one entry per card field. Each has a `name` (the front matter key), a `label` (what the page shows) and a `kind`:
  - `select` (one of `options`) and `multiselect` (any of them);
  - `text`, `list` (free values), `number` and `date`;
  - `cards` (other cards, by number).
  - An option can be an object: `{ value, label, color, variant }`.
    - The `value` goes in the card's front matter; the page shows the `label` (the value when there's none).
    - `color` names one of the theme's palette: `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `teal`, `cyan`, `blue`, `indigo`, `violet`, `pink`, `gray`. The pill is tinted with it and follows light and dark. Any CSS colour works too, the same in both themes.
    - `variant` is a badge style (`primary`, `secondary`, `destructive`, `outline`), for options without a colour.
  - `tile: true` shows the field on the card's tile, as badges.
  - `marker: true` (on one field, usually the priority) colours the tile's left border with the value's `color`.
- `template`: the Markdown a new card starts with.

The page's **Board** button edits all of this visually: columns (order, titles, folders), fields (order, kind, tile and marker, help, and options with labels and colours from the palette) and the template. It writes `board.yml` through a `config` change. Comments in `board.yml` don't survive an edit on the page.

**A card** is `<number>-<slug>.md` in its column's folder:

```markdown
---
id: 12
title: Password reset by email
type: feature
priority: P1
effort: M
components: [api, web]
depends_on: [7, 9]
created: 2026-10-01
---

People who forgot their password get a single-use reset link by email.

## Acceptance criteria

- [ ] "Forgot password" sends a link that works once, for 30 minutes
- [ ] Asking for an unknown address looks the same as for a known one
- [ ] Setting a new password signs out every other session

## Tasks

- [ ] Token table and expiry job
- [ ] Reset email template
- [ ] Reset form and its rate limit

## Progress

What's done, what's verified and how, and what's left. Rewrite it; git has the history.
```

- Front matter keys go in this order: `id`, `title`, the board's fields in `board.yml` order, then `created`. Lists are written inline (`[a, b]`), and empty fields are left out.
- The body is Markdown (GitHub's flavour). A ticket number in it (`APP-7`) links to that card on the page.
- A card is a story. Its **acceptance criteria** say when it's done. Its **tasks** are the work, broken down, in the order it's done. Both are task lists (`- [ ]`) under their `##` headings. The page counts them into the tile's progress bar, and it can tick them and drag them into another order within their list.
- A card's number is never used twice: a new card gets one more than the highest number the board has had, deleted cards included (`git log` knows them).
- The file name keeps its first title. Renaming a card doesn't rename its file.
- The card's column is its folder. Moving a card means moving its file and updating both columns' `_<column>.md`.
- `_<column>.md` is `# <Column title>`, a blank line, then `1. [APP-12: Password reset by email](012-password-reset-by-email.md)` per card, top first. It says `No cards.` when the column is empty. A card missing from the list sorts last.

**README.md** is `templates/readme.md` filled in: the board's name, a line linking this skill's repository, a table of the columns and their counts, and the cards of the columns that matter now. Refresh it whenever you commit board changes.

## Working the board

- **Read the board before picking work**: the user moves cards on the page and by hand.
- **Work "Ready to start" top to bottom, one task at a time.**
  1. Move the card to "In progress".
  2. If its criteria say they're written when it's scheduled, write them first.
  3. Implement, and run the repository's whole verification flow.
  4. Rewrite the card's Progress: what's done, how it was verified, what isn't.
  5. Tick the criteria that are met, and only those.
  6. Move the card to "In review", and commit.
- **One task, one commit.** The subject starts with its ticket (`APP-12: Password reset by email`). The commit carries the card too: its move and its Progress.
- **Only the user moves a card to Done.**
- **Board upkeep never gets a card or a ticket.** New cards, reordering, and the user's moves on the page are committed as their own commit, subject `Board: <what changed>`, when the user asks for a commit or a push. They never ride in a task's commit.
- **No history in the cards.** There are no revision logs and no "imported from" notes: git keeps the history.
- To answer "how are things", read the columns in order: in progress, in review, ready, next.

## The dashboard

The page is `board/` in this skill. It needs the board injected next to it as `data.js`, and a static server so that VS Code's Simple Browser can open it and so that its changes can reach you. Everything below runs from the repository's root, and everything it makes lives in `.ai/local/kanban/`, which is untracked.

**1. Inject** the board: link the page's files and write `data.js`. Do this again after every change you make to `.ai/kanban/`, so the page shows it (it reloads `data.js` every 3 s).

```sh
python3 - <<'EOF'
import hashlib, json, os, pathlib
from datetime import datetime, timezone
board, view = pathlib.Path('.ai/kanban'), pathlib.Path('.ai/local/kanban')
page = pathlib.Path(os.path.expanduser('~/.claude/skills/kanban/board')).resolve()
view.mkdir(parents=True, exist_ok=True)
for name in ('index.html', 'app.js', 'app.css', 'templates', 'vendor'):
    link = view / name
    if link.is_symlink() and link.resolve() != (page / name).resolve():
        link.unlink()  # the skill moved
    if not link.is_symlink():
        link.symlink_to(page / name)
paths = [p for p in sorted(board.rglob('*'))
         if p.is_file() and p.suffix in ('.md', '.yml') and p.name != 'README.md']
files = {p.relative_to(board).as_posix(): p.read_text(encoding='utf-8') for p in paths}
stats = {p.relative_to(board).as_posix(): {'modified': datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(),
                                           'size': p.stat().st_size} for p in paths}
applied = view / 'applied.json'
data = {'version': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:12],
        'applied': (json.loads(applied.read_text()) if applied.exists() else [])[-500:],
        'files': files, 'stats': stats}
tmp = view / 'data.js.tmp'
tmp.write_text('window.KANBAN_DATA = ' + json.dumps(data, ensure_ascii=False) + ';\n', encoding='utf-8')
tmp.replace(view / 'data.js')
print('injected', len(files), 'files as version', data['version'])
EOF
```

**2. Serve** it on loopback, unless it's already up (`curl -sf http://127.0.0.1:8124/ >/dev/null`):

```sh
nohup python3 -m http.server 8124 --bind 127.0.0.1 --directory .ai/local/kanban >> .ai/local/kanban/server.log 2>&1 &
```

Give the user the link, `http://127.0.0.1:8124/`. In VS Code, a workspace whose `workbench.externalUriOpeners` maps `127.0.0.1:8124` to `simpleBrowser.open` opens it in the Simple Browser. `#APP-12` opens a card, `#APP-12/edit` its editor, `#new` the New card form. Another project's board needs another port, and its own mapping.

**3. Watch for changes** while the page is open. Run a Monitor on the server log, and re-arm it when it expires:

```sh
tail -n 0 -F .ai/local/kanban/server.log | grep --line-buffered -o 'GET /\.changes/[A-Za-z0-9_-]*'
```

**4. Apply** the changes. The page doesn't write files. Each change the user makes is sent to the server as `GET /.changes/<base64url JSON>`; the server answers 404 and logs it, and the log is the queue. Each event from the watch, or any time you pick the board up, list what's pending:

```sh
python3 - <<'EOF'
import base64, json, pathlib, re
view = pathlib.Path('.ai/local/kanban')
done = set(json.loads((view / 'applied.json').read_text())) if (view / 'applied.json').exists() else set()
version = re.search(r'"version": "([^"]+)"', (view / 'data.js').read_text()).group(1)
for m in re.finditer(r'GET /\.changes/([A-Za-z0-9_-]+)', (view / 'server.log').read_text(errors='replace')):
    c = json.loads(base64.urlsafe_b64decode(m.group(1) + '=' * (-len(m.group(1)) % 4)))
    if c['id'] not in done:
        done.add(c['id'])
        print(json.dumps({**c, 'base_is_current': c.get('base') == version}, ensure_ascii=False))
EOF
```

Each change has:
- `summary`, one line;
- `op` and its intent:
  - `move` (card, column, index);
  - `save` (card, title, column, fields, body);
  - `create` (card, title, column, fields, body, created);
  - `delete` (card), which the page confirms twice, the second time by the ticket typed in;
  - `task` (card, task): tick or untick the body's nth task list item, counting criteria and tasks together;
  - `reorder` (card, task, index): move the nth item to position `index` within its own list, along with its continuation lines and nested items;
  - `config` (board: the whole settings): rewrite `board.yml`, give a new column its folder's `_<column>.md`, rewrite the order files when the key changed, and drop the order file of a removed column, which must be empty;
- `writes` (path to content, relative to `.ai/kanban/`) and `deletes`: the files the change results in on the version it was made on (`base`).

Apply the changes in order:
- **`base_is_current` is true** (nothing else changed the board since it was injected): write every path in `writes` exactly as given, and delete the `deletes`.
- **Otherwise**, apply the intent to the files as they are now.

When a change conflicts with something you changed meanwhile, keep both where you can, and tell the user what you did.

Then:
1. Append the ids to `.ai/local/kanban/applied.json` (a JSON list), and inject again. The page stops showing them as pending.
2. Once nothing is pending, empty the log (`: > .ai/local/kanban/server.log`); it grows by a line every 3 s the page is open.

Don't commit on your own: a change from the page is board upkeep (see above).

**Stop** the server when you're done: `pkill -f 'http.server 8124'`.

## Setting up a board

1. Create `.ai/kanban/` with `board.yml` from `templates/board.yml`. Set the name and the ticket key (the user's choice, two to four capitals) and adjust the columns and fields.
2. Make a folder per column, each with its `_<column>.md` ("No cards.").
3. Write `README.md` from `templates/readme.md`.
4. Add a line on the board to the repository's `.ai/AGENTS.md` conventions: tasks live in `.ai/kanban` (this skill), ticket IDs in commit subjects, one task one commit.
5. Commit it as `Board: set up`.
