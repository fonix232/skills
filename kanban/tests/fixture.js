// A small board, injected the way the agent injects one (see SKILL.md), for tests/index.html.
window.KANBAN_DATA = {
  version: 'fixture-1',
  applied: [],
  files: {
    'board.yml': `name: Demo
key: DEMO
columns:
  - id: todo
    title: Ready to start
  - id: doing
    title: In progress
  - id: done
    title: Done
fields:
  - name: type
    label: Type
    kind: select
    options: [feature, bug, chore]
  - name: priority
    label: Priority
    kind: select
    marker: true
    options:
      - { value: P0, label: Critical, color: red }
      - { value: P1, color: '#ffc53d' }
      - P2
  - name: roles
    label: Runs on
    kind: multiselect
    tile: true
    options:
      - { value: router, label: Router, color: blue }
      - ap
      - switch
  - name: components
    label: Components
    kind: list
  - name: depends_on
    label: Depends on
    kind: cards
template: |
  Describe the card.

  ## Acceptance criteria

  - [ ] The first criterion
`,
    'todo/_todo.md': `# Ready to start

1. [DEMO-2: Second card](002-second-card.md)
2. [DEMO-1: First card](001-first-card.md)
`,
    'todo/001-first-card.md': `---
id: 1
title: First card
type: feature
priority: P0
roles: [router, ap]
components: [agent, controller]
depends_on: [2]
created: 2026-09-29
---

The first card, after DEMO-2.

## Acceptance criteria

- [x] Done already
- [ ] Not yet

\`\`\`md
- [ ] Not a criterion: inside a code block
\`\`\`

- [ ] Last one

## Tasks

- [ ] Task one
- [x] Task two
  with a second line
- [ ] Task three

| Column | Cards |
| --- | --- |
| todo | 3 |
`,
    'todo/002-second-card.md': `---
id: 2
title: Second card
priority: P1
---

Second.
`,
    'todo/004-unlisted.md': `---
id: 4
title: Unlisted card
---

Not in the order file: it goes last.
`,
    'doing/_doing.md': `# In progress

1. [DEMO-3: Third card](003-third-card.md)
`,
    'doing/003-third-card.md': `---
id: 3
title: 'Third: with a colon'
type: bug
---

Third.
`,
    'done/_done.md': `# Done

No cards.
`,
  },
};
