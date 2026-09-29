# kanban

A task board kept as Markdown in the repository, worked by an AI coding agent, with a dashboard in the browser. It's a skill for Claude Code (and any agent that reads `SKILL.md`): the agent keeps the board's files, and the page shows them and lets you change them.

A small Python standard-library server serves the dashboard, reads the Markdown, reserves ticket IDs and durably queues proposed edits. The agent remains responsible for all board-file changes.

## The board

A project's board lives in `.ai/kanban/` and is committed with the work:

```
.ai/kanban/
  README.md            the status, for people reading the repository
  board.yml            name, ticket key, columns, card fields, new-card template
  backlog/
    _backlog.md        the column's cards in order (a numbered list of links)
    012-password-reset-by-email.md
  todo/ …
```

Each card is Markdown with its fields in YAML front matter. `board.yml` defines the fields: selects, multi-selects, text, lists, numbers, dates, and links to other cards. Each one gets its own input on the page. The body is GitHub-flavoured Markdown: a description, the acceptance criteria as a task list, and the progress. Ticket IDs (`APP-12`) come from the board's key and go at the start of commit subjects.

[`SKILL.md`](SKILL.md) is the full reference and the agent's instructions.

## The dashboard

`board/` is the page: Basecoat (shadcn/ui's design system in plain HTML and CSS), Tailwind's browser build, Sortable for dragging, Mustache for the templates, marked and DOMPurify for Markdown, and js-yaml for front matter. All of it is vendored, so it works offline.

- Run `python3 ~/.claude/skills/kanban/scripts/serve.py` from a project with `.ai/kanban/board.yml`. It serves fresh board data on `127.0.0.1:8124`; VS Code's Simple Browser can open it. Runtime state stays in ignored `.ai/local/kanban/`.
- Tiles show the priority as the colour of their left edge, and the criteria and tasks done as a progress bar. You drag cards between columns and within them.
- A card opens as JIRA shows an issue: the details (Markdown) in the main column, the fields in a side column, and the file behind an info icon. Criteria and tasks can be ticked, and dragged into another order within their list. Editing and creating cards use the same layout, with a Markdown preview.
- Deleting takes two steps: the red Delete, then typing the ticket to confirm.
- **Board** edits `board.yml` visually: the columns and their order, the fields (kind, tile, border colour, help, and a select's options with labels and colours picked from the theme's palette) and the new-card template.
- The page sends JSON POST requests to a durable inbox. The agent checks fresh files, merges the changes and acknowledges application. Failed deliveries remain visible for retry. Incoming changes in an open editor have per-field Accept/Decline notices; the page never overwrites typing automatically.
- Settings changes that affect existing card values require a migration review. Keep the original field, choose replacement values, or explicitly confirm removals; settings and migrations travel together.
- Incoming settings have Accept/Decline notices. Open card editors retain typing while the user reviews a changed schema.
- Unsaved card and settings drafts survive reloads in the same browser tab. Reopen the editor to restore them; closing it asks before discarding. Closing the tab can clear these browser drafts.
- Connection loss is visible. Changes show Not delivered, Queued for agent, Needs resolution (with the agent's reason), or Applied.
- Ticket numbers are reserved centrally, and acknowledgements clear pending edits even if the final board content is unchanged. Existing log-based sessions must be reconciled before switching; see `SKILL.md`.

The templates are `board/templates/`:
- `dashboard.js`: the board, its columns and card tiles;
- `card-modal.js`: a card, to read or edit;
- `new-card.js`: the New card form;
- `fields.js`: the field inputs and the Markdown editor the two share;
- `settings.js`: the board settings editor.

## Install

Clone the skills repository, and link the skill in:

    git clone https://github.com/fonix232/skills ~/Workspace/skills
    ln -s ~/Workspace/skills/kanban ~/.claude/skills/kanban

Then ask the agent to set up a board, or to open one.

## Tests

Run `python3 -m unittest discover -s tests -p 'test_*.py'` for HTTP and durable-inbox tests.

The page's tests run in a browser, on a fixture board. Serve the repository, and open `tests/index.html`:

    python3 -m http.server 8179 --bind 127.0.0.1 &
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --virtual-time-budget=6000 \
        --dump-dom http://127.0.0.1:8179/tests/index.html | grep -o '<title>[^<]*</title>'

The title reads `PASS <checks>` or `FAIL <failures>`, and the page lists every check.

## License

MIT, see [LICENSE](LICENSE). The vendored libraries keep their own licenses, in `board/vendor/licenses/`: MIT, except DOMPurify (Apache-2.0 or MPL-2.0).
