<!--
  The template for a board's .ai/kanban/README.md. The agent fills it in (Mustache-style
  placeholders, listed below) whenever it commits board changes, and drops this comment.

  {{name}}          board.yml's name
  {{key}}           board.yml's key
  {{#columns}}      every column, in board.yml's order: {{id}}, {{title}}, {{count}}
  {{#active}}       the columns with cards that matter now, in this order when they have
                    any: In progress, In review, Ready to start, Next. Each lists its
                    {{#cards}}: {{ticket}}, {{title}}, {{file}} (relative to .ai/kanban)
-->
# {{name}}: the board

The project's tasks, one Markdown card each, kept with [kanban](https://github.com/fonix232/skills/tree/main/kanban): a folder per column, cards named `<number>-<title>.md`, and each column's order in its `_<column>.md`. Tickets are `{{key}}-<number>`, and commit subjects start with theirs.

| Column | Cards |
| --- | --- |
{{#columns}}
| [{{title}}]({{id}}/_{{id}}.md) | {{count}} |
{{/columns}}

{{#active}}
## {{title}}

{{#cards}}
- [{{ticket}}]({{file}}): {{title}}
{{/cards}}

{{/active}}
