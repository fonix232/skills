---
name: kanban
description: "Work a repository's task board. The board is Markdown in the repository (.ai/kanban, committed): one folder per column, one card per task with its fields in front matter, ticket IDs (JIRA style, e.g. APP-12) for commit messages. Covers setting a board up, opening the dashboard (a page this skill ships, served with fresh board data and a durable change inbox), applying the changes made on the dashboard, picking up queued work, moving cards, one verified commit per task, and the review cycle (end-to-end verification, then Done in the ticket's own commit). Use when the user says to work the board, pick up ready tasks, start or finish a task, open or show the board, asks what's next or how things stand, or asks for a board in a new repository."
---

# Kanban

A project's board is Markdown in the repository, under `.ai/kanban/`, committed with the work.
The dashboard (`board/`) renders the board in a browser. A small standard-library Python
server (`scripts/serve.py`) reads the board and durably queues browser changes. Only the
agent edits the Markdown files; the server never applies a change to them.

## The board: `.ai/kanban/`

```
.ai/kanban/
  README.md            the board's status, for people reading the repository (see below)
  board.yml            name, ticket key, columns, fields, the new-card template
  <column>/            one folder per column, named by the column's id
    _<column>.md       the column's cards in order: a numbered list of links, top first
    012-password-reset-by-email.md
  attachments/
    <KEY>-<n>/         a card's images (PNG, JPEG, WebP, GIF), such as proof screenshots
  <level>/             optional: the documents above the cards (see `levels`), such as
    I1-<slug>.md       initiatives/ and epics/
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
  - `scope: true` (on one `select` field, usually the milestone) makes it the board's scope. The board shows it as swimlanes: one row of columns per value, plus one for cards without a value. A picker in the top bar shows one lane at a time or every lane; with every lane shown, the current value's lane starts open and the others folded, and the viewer can fold or open each one (remembered in that browser). The column counts follow the picker.
    - The option marked `current: true` is shown by default. Move the flag when the next milestone starts.
    - `?scope=<value>` in the address picks another value, and the picker keeps its choice there: `*` is every card, `-` the cards without a value.
    - A card created while a value is shown starts with it.
- `template`: the Markdown a new card starts with.
- `levels` (optional): the documents above the cards, such as initiatives and then epics, shown in the page's outline view next to the board. Each level is `{ id, title, parent, field }`:
  - `id` is the level's folder in the board, holding one Markdown document per item, with `id`, `title` and `status` in its front matter (`draft`, `reviewed`, `approved`, `in-progress`, `done` get colours);
  - `parent` (every level but the first) names the front matter key that holds the parent level's document ID (`initiative: I1`);
  - `field` (the last level) names the card field that holds the document's ID (`epic: E1.2`).

  The outline shows the tree with each document's status and the share of its cards in the last column, and lists the cards under their document; cards in none are listed apart. The scope picker filters it too: a document shows when its front matter carries the value (`milestone: M1`, or a list in `milestones`), or its cards do. Documents open read-only; the agent writes them. The settings editor keeps `levels` as they are.

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
- Images go in `attachments/<KEY>-<n>/` and the card links them as `![What it shows](../attachments/APP-12/reset-form.png)`, a path that works from any column on GitHub too. The page shows them; the server serves image files from that folder and nothing else from the repository. Keep them few and small (a few hundred KB each), and commit them with the card.
- A card is a story. Its **acceptance criteria** say when it's done. Its **tasks** are the work, broken down, in the order it's done. Both are task lists (`- [ ]`) under their `##` headings. The page counts them into the tile's progress bar, and it can tick them and drag them into another order within their list.
- A card's number is never used twice: a new card gets one more than the highest number the board has had, deleted cards included (`git log` knows them).
- The file name keeps its first title. Renaming a card doesn't rename its file.
- The card's column is its folder. Moving a card means moving its file and updating both columns' `_<column>.md`.
- `_<column>.md` is `# <Column title>`, a blank line, then `1. [APP-12: Password reset by email](012-password-reset-by-email.md)` per card, top first. It says `No cards.` when the column is empty. A card missing from the list sorts last.

**README.md** is `templates/readme.md` filled in: the board's name, a line linking this skill's repository, a table of the columns and their counts, and the cards of the columns that matter now. Refresh it whenever you commit board changes.

## Working the board

A ticket moves through the columns in order, and each move has an owner:

1. **Backlog**: the agent writes the cards. Their criteria say they're written when the card is scheduled.
2. **Next**: the user reads the backlog and moves the cards they want next.
3. **Ready to start**: the user and the agent agree the next sprint's scope and move those cards here. The agent writes each card's criteria as it's scheduled.
4. **In progress**: the agent works the Ready cards one ticket at a time, in parallel where tickets don't touch the same code, and moves each card here when it starts. Each ticket is designed, developed, tested (unit, integration and end-to-end tests written) and verified (checked by hand, on real devices where it matters).
5. **In review**: once all four are done, the agent:
   - rewrites the card's Progress: what's done, how it was verified, what isn't;
   - ticks the criteria that are met, and only those;
   - moves the card here;
   - commits the ticket (`APP-12: Password reset by email`).
6. **Done**: review is end-to-end verification by someone other than the author, such as verifier agents fanned out one per area. It covers the whole test suite, every criterion, and edge cases on the happy and unhappy paths. A verified ticket's card moves to Done inside the ticket's own commit (amend it, or rewrite the history when later commits followed), and the result is pushed when the user says so. A ticket that fails review goes back to In progress with what failed in its Progress.

- **Read the board before picking work**: the user moves cards on the page and by hand.
- **One task, one commit.** The subject starts with its ticket. The commit carries the card too: its moves and its Progress.
- **Board upkeep never gets a card or a ticket.** New cards, reordering, and the user's moves on the page are committed as their own commit, subject `Board: <what changed>`, when the user asks for a commit or a push. They never ride in a task's commit.
- **No history in the cards.** There are no revision logs and no "imported from" notes: git keeps the history.
- To answer "how are things", read the columns in order: in progress, in review, ready, next.

## The dashboard

The server reads `.ai/kanban/` fresh on every poll and serves it as `data.js`. All runtime
state lives under ignored `.ai/local/kanban/`. Run these commands from the project root.

**1. Start the dashboard.** Check `http://127.0.0.1:8124/api/health` first; reuse it only
if its `service` is `kanban-inbox` and its `board` is this project's resolved board path.
Use another port for a different board. Confirm `/.ai/local/` is ignored before starting.

```sh
mkdir -p .ai/local/kanban
nohup python3 ~/.claude/skills/kanban/scripts/serve.py \
  --board .ai/kanban --view .ai/local/kanban --port 8124 \
  >> .ai/local/kanban/server.log 2>&1 &
echo $! > .ai/local/kanban/server.pid
```

Give the user `http://127.0.0.1:8124/`. It also works in VS Code's Simple Browser.
`#APP-12` opens a card, `#APP-12/edit` its editor, and `#new` the New card form.
The page refreshes every 3 seconds. In an open editor, incoming field changes appear
beside that field with **Accept** and **Decline** buttons. Accept replaces the local value;
Decline keeps it. Resolve every notice before saving. An incoming deletion keeps the draft
visible for copying and disables Save.
Details are edited in a rich Markdown editor. A saved body keeps the exact text of every
block the user didn't touch; blocks they edited come back in the editor's style (`-`
bullets, four-space nesting), which is theirs to keep, not to normalize.

**2. Read the durable inbox** while working the board, and whenever resuming a session:

```sh
curl -fsS http://127.0.0.1:8124/api/changes
```

The page sends `POST /api/changes` with a JSON body. The server acknowledges it only after
committing it to `.ai/local/kanban/inbox.sqlite3`; retries with the same change ID are
idempotent. Changes remain pending until the agent explicitly acknowledges application.
The page distinguishes Not delivered, Queued for agent, Needs resolution, Applied and Cancelled.
A failed poll shows that the board may be out of date. Delivery failures show a Retry button; the browser retains pending changes across reloads
when storage is available. The request limit is 8 MiB; oversized changes show an error.
Do not delete or truncate the inbox. `server.log` is diagnostic output, never a queue.
Poll the inbox periodically while assisting the user; no special Monitor tool is required.

Each change has:
- `id`, `summary`, and `base` (the board-content version last loaded);
- `requires`: earlier pending changes it was built on; apply these first;
- `op` and its intent: `move` (card, column, index), `save` (card, title, column, fields,
  body), `create` (card, title, column, fields, body, created), `delete` (card), `task`
  (card, task index), `reorder` (card, task index, destination index within its list), or
  `config` (the edited board settings, including columns, fields and template; it updates
  `board.yml` and the affected column order files, including new/removed empty columns);
- `writes` and `deletes`, relative to `.ai/kanban/`, and `before`: the original text of
  every touched path, or `null` when that path did not exist. These snapshots include any
  preceding pending edits; they are more precise than `base` alone.

**3. Check and apply one change at a time.** Immediately before applying each event, ask
for a fresh comparison against the actual files, using that event's ID:

```sh
curl -fsS -H 'Content-Type: application/json' \
  -d '{"id":"CHANGE_ID"}' http://127.0.0.1:8124/api/check-change
```

- If `cancelled` is true, the user withdrew the change on the dashboard: skip it, and never
  apply or acknowledge it. `GET /api/changes` no longer lists it, and a cancelled
  prerequisite no longer blocks anything.
- If `blocked_by` is nonempty, finish those prerequisite changes first.
- If `already_written` is true, verify the complete result and acknowledge it without
  replaying toggles or creates; this handles a previous session stopping before acknowledgement.
- If `paths_match` is true, all touched files still match their `before` snapshots. Write
  the specified contents and remove the specified files. Check that paths resolve inside
  the board and recheck any file that changes between comparison and writing.
- Otherwise, read the current files and merge the intent using `before`, the proposed
  contents, and the actual contents. Never treat an old injected version or the batch's
  initial comparison as proof that later writes are safe. For checklist changes, identify
  the original item by its text/context; a changed index alone is not enough.
- A `config` event may include `migrations`: explicit per-card field replacements or removals,
  with original values in `before`. Apply these together with the settings, preserving any
  independent card edits. A stale migration value needs resolution, never blind replacement.
- For `config`, compare against the settings editor's original `board.yml` snapshot and
  keep unrelated configuration changes. Never remove a column that now contains cards.
- Preserve independent edits. Leave ambiguous conflicts pending and explain them to the
  user; do not acknowledge or apply dependent events until resolved. Report the reason to
  `POST /api/change-status` as `{"id":"CHANGE_ID","reason":"What needs a decision"}`.
  This makes the pending event visibly **Needs resolution**. Send an empty `reason` after
  resolution to return it to **Queued for agent**, or acknowledge it after verified application.

Creating cards reserves an ID through `POST /api/reserve-id` with `{"id":"UNIQUE_REQUEST_ID"}`.
The server serializes reservations and takes the maximum across current card IDs, stored
reservations and numbered card filenames in available Git history, including deletions.
Keep the inbox database when restarting; a shallow clone cannot recover history it lacks.
The browser uses its create-event ID as the reservation key, so retries get the same ticket.
When the agent creates cards while the dashboard is running, use this endpoint too.
Before writing a create, check the full board for that ID; never overwrite an existing card
or create duplicate IDs. If an out-of-band edit consumed a reserved ID, leave the event
pending and resolve the collision and its dependent references before applying it.

**4. Acknowledge only verified results**, by posting the successfully applied event IDs:

```sh
curl -fsS -H 'Content-Type: application/json' \
  -d '{"ids":["CHANGE_ID"]}' http://127.0.0.1:8124/api/applied
```

New arrivals remain in the inbox during acknowledgement; nothing is truncated. The next
poll clears pending indicators even if the board's contents ended up unchanged. Refresh
the board README before committing. Dashboard edits are board upkeep: do not commit them
unless the user asks for a commit or push.
If the acknowledgement is refused because a change was cancelled, the user withdrew it while
you were applying it: restore each touched path from its `before` snapshot (delete it when
`before` is `null`), merging any edits made since, and don't acknowledge it.

**Cancelling.** The page's bell lists the changes waiting for the agent, each with **Cancel**
(their toasts have it too). `POST /api/cancel` with `{"ids":[...]}` (and `"dry_run": true` to
only ask) cancels them with every later pending change that touches one of their files,
since those changes' contents were built on them, and returns `cancelled`, `summaries` and
`paths`. Applied changes can't be cancelled. The page asks before cancelling more than the one
picked. The server keeps cancelled changes as tombstones, so a late retry stays cancelled.

**Stop** only the server started for this board. Read `server.pid`, verify that the PID's
command is this server with the expected board/view arguments, then send it SIGTERM.
Do not use a broad `pkill` pattern or remove the inbox when stopping.

**Existing log-based sessions:** finish applying and verifying their pending log events
with the previous client before switching servers. Keep `server.log` and `applied.json`
until reconciled; the new inbox does not automatically import old GET events. Stop the
old server before starting the POST server on the same port, then reload the dashboard.

Settings edits that remove populated fields, change field types or remove used options
require a migration review. Users can choose replacement values, explicitly confirm removals,
or preserve the original field. Existing unknown option values remain editable and are
preserved on ordinary card saves. Incoming settings show Accept/Decline notices; an open
card editor must review a changed schema before saving.

Unsaved card, new-card and settings drafts are retained in browser session storage per tab
and board. Reopening the editor restores its draft; closing asks before discarding it.
Reloading preserves drafts, but closing the browser tab can clear session storage. Drafts
are separate from the server's durable inbox and are not instructions to edit board files.

## Setting up a board

1. Create `.ai/kanban/` with `board.yml` from `templates/board.yml`. Set the name and the ticket key (the user's choice, two to four capitals) and adjust the columns and fields.
2. Make a folder per column, each with its `_<column>.md` ("No cards.").
3. Write `README.md` from `templates/readme.md`.
4. Add a line on the board to the repository's `.ai/instructions.md` conventions: tasks live in `.ai/kanban` (this skill), ticket IDs in commit subjects, one task one commit.
5. Commit it as `Board: set up`.
