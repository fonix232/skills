# skills

Skills for Claude Code (and other agents that read `SKILL.md`), one per folder:

- [`kanban/`](kanban): a task board kept as Markdown in the repository (`.ai/kanban/`), worked by the agent, with a dashboard in the browser. No program runs: the agent injects the board into a static page and applies the changes made on it.
- [`ai-scaffolding/`](ai-scaffolding): a repository's AI tooling in one place. `.ai/instructions.md` is the single source of instructions, linked as `CLAUDE.md`, `AGENTS.md` and the rest, with skills, agents, plans and local notes under `.ai/`.

## Install

Clone the repository, and link each skill into `~/.claude/skills`. Claude keeps its own synced skills in that folder too, so the repository lives beside it:

    git clone https://github.com/fonix232/skills ~/Workspace/skills
    for skill in kanban ai-scaffolding; do ln -s ~/Workspace/skills/$skill ~/.claude/skills/$skill; done

`git pull` then updates them all.

## License

MIT, see [LICENSE](LICENSE). kanban's vendored libraries keep their own licenses, in `kanban/board/vendor/licenses/`.
