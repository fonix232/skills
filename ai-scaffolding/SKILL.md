---
name: ai-scaffolding
description: Set up, migrate or check repository AI scaffolding using `.ai/instructions.md` as the shared instructions and `.ai/` for skills, agents, commands and plans, with tool-specific symlinks. Use when establishing project AI tooling, migrating an older instruction layout, adding project skills or agents, or fixing or checking scaffolding.
---

# AI scaffolding

Every repository keeps its AI tooling in `.ai/`, the only place it is edited. Each tool
finds it through a symlink, so all tools read the same instructions, skills and agents.
`.ai/instructions.md` is the source of truth for project instructions. Tool entry files
are aliases; preserved migration sources are historical copies, not active authorities.

## The layout

```
.ai/
  instructions.md            the instructions: the single source
  agents/<name>.agent.md     subagents (reviewers, specialists)
  skills/<name>/SKILL.md     project skills
  commands/                  slash commands (.gitkeep while empty)
  plans/                     tracked plans (roadmap.md, ...)
  local/                     untracked: reviews, investigation evidence, logs, scratch
AGENTS.md, CLAUDE.md, CODEX.md, GEMINI.md   -> .ai/instructions.md
.github/copilot-instructions.md             -> ../.ai/instructions.md
.github/agents, .claude/agents              -> ../.ai/agents
.github/skills, .claude/skills,
  .agents/skills (Codex, Gemini CLI), .codex/skills -> ../.ai/skills
.claude/commands                            -> ../.ai/commands
```

Ensure `.gitignore` includes each pattern below, preserving unrelated rules and avoiding
duplicate entries:

```
# AI tooling: per-user runtime state only. .claude/agents|commands|skills are symlinks into
# .ai/ and stay tracked.
.claude/settings.local.json
.claude/scheduled_tasks.lock
.claude/worktrees/

# Local reviews, investigation evidence and scratch notes.
/.ai/local/
```

## Workflow

For a check or review request, inspect and report deviations without changing files or
committing. For setup or migration, make the changes directly using the layout above.
When adding a skill or agent, keep changes scoped to that addition and its required links.

1. **Inspect the repository root and working tree.** Read existing instructions and inspect
   symlink targets before changing anything. Include `.ai/instructions.md`, older
   `.ai/AGENTS.md` or `.ai/INSTRUCTIONS.md`, root instruction files, and
   `.github/copilot-instructions.md`, `.claude/CLAUDE.md` and `.codex/AGENTS.md`.
   Check for competing instructions even when `.ai/instructions.md` already exists. Preserve
   unrelated edits and existing staged changes.
2. **Consolidate instructions into a regular `.ai/instructions.md` file.** Preserve every unique
   fact and rule and restructure using the outline below. Follow **Preserving symlink
   sources** before replacing any instruction path. Merge compatible content; ask about
   contradictory rules whose intended resolution is unclear. Remove or move superseded
   regular files only after their content is preserved and only if they are not protected
   symlink targets. Use `git mv` for eligible tracked migrations where practical. Update
   migrated entry links and active references using **Instruction references** below;
   leave preserved source files unchanged.
3. **Consolidate skills, agents and commands.** Move existing content from the tool
   directories shown above into the corresponding `.ai/` directories before replacing
   them with relative symlinks. Inspect existing links rather than moving their targets.
   Compare same-name entries and preserve unique content; do not overwrite conflicts.
   Include hidden files. Deduplicate identical empty `.gitkeep` files; add placeholders
   only to empty tracked directories after migration.
4. **Complete the layout.** Create the listed relative symlinks and missing directories.
   Remove obsolete `.claude/CLAUDE.md` and `.codex/AGENTS.md` links after verifying their
   instructions are preserved in the canonical file. For full setup, add at least one
   project reviewer and the relevant project skills, listing each in `.ai/instructions.md`.
   Plans belong in `.ai/plans/` (`roadmap.md` for a new project); evidence, logs and
   one-off notes belong in ignored `.ai/local/`. Update each required ignore pattern.
5. **Verify and finish.** Use the checks below. If any migration source or conflict remains
   unresolved, report the migration as incomplete and do not commit it. Leave affected
   original paths unchanged; keep dependent merges and reference updates as drafts until
   the issue is resolved. Independent changes may remain for review. Once verification
   passes and all migration issues are resolved, commit only the
   scaffolding changes as one commit unless the user requested otherwise. Stage explicit
   paths or hunks and inspect the staged diff; do not use blanket `git add -A`. Preserve
   unrelated staged changes and exclude them from the scaffolding commit. Report what
   changed and any unresolved deviations.

## Preserving symlink sources

Treat legacy symlink targets as source material to copy and merge, not files to move,
delete or edit. This applies to targets inside and outside the repository. An established
regular `.ai/instructions.md` is the editable canonical file, not a protected legacy
source, even when tool entry links point to it. Preserve its existing rules when merging
authorized changes. If that path is itself a symlink, its old target remains protected.
The preservation requirements below apply to legacy sources and their intermediate links.

1. Before changing paths, record each instruction link's literal target and resolve its
   chain relative to each link's parent directory. Read each distinct final source once;
   keep its original bytes and a record of the chain in temporary migration evidence.
   Preserve intermediate links and final target files at their original paths. If a
   source is dangling, cyclic or unreadable, leave its entry link untouched and report
   the unresolved source rather than silently dropping its instructions.
2. Draft the merged `.ai/instructions.md` in a separate regular temporary file. Include
   existing canonical content, all readable instruction sources and the new instructions.
   Deduplicate equivalent rules, preserve unique rules and their harness or role scope,
   and resolve ambiguous contradictions with the user before replacing affected paths.
   Adjust relative references in the merged copy for their new location, while keeping
   the original source files unchanged.
3. Verify the draft against the source snapshots before installing it. If the canonical
   path is a symlink, replace only that directory entry with the prepared regular file;
   never redirect output or copy onto a path that still follows the old link. Repoint
   the tool entry links to the new canonical file only after the merge is complete.
   If a protected target or intermediate link itself occupies a path the layout requires
   replacing, leave the affected paths unchanged and ask how to resolve that conflict.
4. Compare preserved targets and intermediate links with the snapshots after migration.
   Report which entry links changed and where their original sources remain. Retained
   sources are preservation exceptions to legacy-file cleanup, not files to delete on a
   later run. Record these exceptions in the canonical instructions so repeat runs respect
   them; omit sensitive source paths from tracked documentation and report those privately.

## Instruction references

When migrating, search repository documentation, skills, agents, commands, templates and
scripts, including hidden tool directories, for references to the former instruction
paths. Update references that identify the authoritative file, tell an agent what to read
or edit, or copy or generate instructions to use `.ai/instructions.md`. Resolve relative
links from the containing file's directory and retain any valid section anchors.

Keep harness entry names such as root `AGENTS.md` and `CLAUDE.md` when describing discovery
or creating their symlinks; their targets must be `.ai/instructions.md` (with the correct
relative prefix). Retain old paths only in migration guidance, historical records and
preserved source files. Do not rewrite preserved originals to update their references;
update the merged copy instead. Document retained sources as inactive historical copies.

## Verification

- `.ai/instructions.md` is a regular file containing the preserved project instructions, and
  migrated tool entry links resolve to it. Any retained legacy sources are documented
  preservation exceptions; unresolved entry links are reported as deviations.
- Active read/edit instructions, templates and generated-file references identify
  `.ai/instructions.md` as the source of truth. Remaining references to old canonical
  paths are limited to the explicit preservation and historical exceptions above.
- Protected legacy symlink targets retain their original bytes and paths, and their
  intermediate links retain their original targets. The merged file includes their applicable instructions
  and the requested additions without silently choosing between contradictory rules.
- Every link in the layout has the stated relative target and resolves inside the
  repository. Preserve unrelated tool configuration alongside these links.
- Skills, agents and commands retain their original content except for intended edits;
  referenced files exist and empty tracked directories have placeholders. `.ai/local/`
  may be absent in a fresh clone.
- Use `git check-ignore -v` with representative paths to verify every runtime-state
  pattern independently, including local settings, scheduled-task locks, worktrees and
  `.ai/local/`. Use `git check-ignore --no-index -v` to detect ignore rules that would
  hide scaffolding even when it is already tracked. Check
  `git ls-files` for already tracked local notes or runtime state: ignore rules alone
  do not untrack files. If removal from tracking is in scope, preserve working copies.
- Review the diff, including staged changes and untracked files, for lost instructions,
  accidental deletions and unrelated changes. Use `git diff --check` (and `--cached`
  for staged changes). A repeated inspection should require no further layout changes.

## `.ai/instructions.md`

```markdown
# <Project>: agent instructions

<What the project is and its goal, one to three sentences.> This file is the single source
of instructions for every AI tool: `AGENTS.md` (Codex), `CLAUDE.md`, `CODEX.md`, `GEMINI.md`
and `.github/copilot-instructions.md` are symlinks to it. Edit only `.ai/instructions.md`. Skills
live in `.ai/skills` and are linked from `.claude/skills`, `.agents/skills` (Codex, Gemini
CLI), `.codex/skills` and `.github/skills`; agents live in `.ai/agents`, linked from
`.claude/agents` and `.github/agents`.

## Layout            a fenced tree of the repository, one line per directory, with `.ai/` last
## <rules>           the project's own: "Architecture rules", "Design rules", or
                     "Hard safety rules (never break these)" where a mistake is costly
## Build and test    exact commands, and how to verify on real hardware or devices
## Conventions       commits, versions, tests, where notes go
## Skills, agents, plans   one bullet per file: `.ai/skills/<name>`: what it covers
```

- Write rules as instructions with their reason, drawn from the project, not generic advice.
  Put facts that are easy to get wrong where the reader needs them.
- Keep common rules shared. Where instructions differ, add a section titled
  `## Harness-specific instructions` with headings such as `### Claude Code only` or
  `### Codex only`, and state that each subsection applies only to that harness. Scope
  role-specific rules similarly (for example, `### Reviewer agents only`). These labels
  guide applicability; every harness still receives the whole file. Keep tool-specific
  configuration in the format its harness requires.
- Conventions always include: one commit per finished, verified task; **no Co-Authored-By
  or other AI attribution trailers**; push only when asked; notes and logs under
  `.ai/local/`.
- Public repositories: say what must never be committed (real IPs, MACs, serials, keys) and
  the placeholders to use instead.
- Keep it to the point. A section that only restates the README doesn't belong.

## Agents: `.ai/agents/<name>.agent.md`

```markdown
---
name: <project>-reviewer
description: Reviews <project> changes for <the project's real failure modes>. Use after <which changes>.
tools: Read, Grep, Glob, Bash
---

You review changes in the <project> repository. Read `.ai/instructions.md` and
`.ai/skills/<most relevant>/SKILL.md` first, then review both unstaged changes (`git diff`)
and staged changes (`git diff --cached`), plus the contents of relevant untracked files.

Check, in this order, and report only real findings with file and line:

1. **<Most severe class>**: what counts as a finding, and how to check it.
2. ...

Be terse. Findings first, most severe first; no praise.
```

## Skills: `.ai/skills/<name>/SKILL.md`

```markdown
---
name: <name>
description: <What it covers and when to use it: the words someone would say when they need it.>
---

# <Title>
```

One skill per area someone works in: a subsystem, the build and verify loop, the
release or publish pipeline, a hardware or device procedure. Each holds the how-to and the
traps, with exact commands and paths. Keep a skill's body under about 300 lines; move long
references into files next to its `SKILL.md`.
