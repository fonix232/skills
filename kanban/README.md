# kanban

A task board kept as Markdown in the repository, worked by an AI coding agent, with a dashboard in the browser. It's a skill for Claude Code (and any agent that reads `SKILL.md`): the agent keeps the board's files, and the page shows them and lets you change them.

No program runs to keep the board. The skill is a ready-made CSS/JS framework and a set of templates. The agent injects the board's Markdown into the page, and the page renders it in the browser.

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

- The agent links the page into the project's `.ai/local/kanban/` and writes the board next to it as `data.js`. It serves that folder with Python's built-in static server on `127.0.0.1:8124`. VS Code's Simple Browser can open it, as can any browser.
- Tiles show the priority as the colour of their left edge, and the criteria and tasks done as a progress bar. You drag cards between columns and within them.
- A card opens as JIRA shows an issue: the details (Markdown) in the main column, the fields in a side column, and the file behind an info icon. Criteria and tasks can be ticked, and dragged into another order within their list. Editing and creating cards use the same layout, with a Markdown preview.
- Deleting takes two steps: the red Delete, then typing the ticket to confirm.
- **Board** edits `board.yml` visually: the columns and their order, the fields (kind, tile, border colour, help, and a select's options with labels and colours picked from the theme's palette) and the new-card template.
- The page writes nothing. Each change is sent to the static server as a request that it logs; the agent watches that log and applies the change to the Markdown, and the page shows it as pending until the agent has written it. Changes from the agent, an editor or git appear within three seconds.

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

The page's tests run in a browser, on a fixture board. Serve the repository, and open `tests/index.html`:

    python3 -m http.server 8179 --bind 127.0.0.1 &
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --virtual-time-budget=6000 \
        --dump-dom http://127.0.0.1:8179/tests/index.html | grep -o '<title>[^<]*</title>'

The title reads `PASS <checks>` or `FAIL <failures>`, and the page lists every check.

## License

MIT, see [LICENSE](LICENSE). The vendored libraries keep their own licenses, in `board/vendor/licenses/`: MIT, except DOMPurify (Apache-2.0 or MPL-2.0).
