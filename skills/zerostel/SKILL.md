---
name: zerostel
description: See what an AI coding agent did in this project and take it back with Zerostel. Use when the user asks what changed, wants to undo or rewind an agent's work, wants the diff of a step, asks about guardrails or blocked commands, or wants to check that a session's record is intact.
license: Apache-2.0
# exact read-only commands only, no wildcards: anything else still asks
allowed-tools:
  - Bash(zerostel log)
  - Bash(zerostel log --changes)
  - Bash(zerostel sessions)
  - Bash(zerostel status)
  - Bash(zerostel verify)
  - Bash(zerostel policy)
---

# Zerostel

Zerostel records every step a coding agent takes in a project (prompts, tool
calls, file changes) and can put the project back the way it was before any
step. It runs locally and sends nothing anywhere.

If `zerostel` isn't on the PATH, don't run it through npx: inside a project,
npx prefers a copy the project itself provides, which could be anything. Ask the user to install Zerostel instead (`npm install -g zerostel`,
or the executable from https://github.com/zerostel/zerostel/releases). If there
are no recordings, Zerostel isn't recording this agent yet: say so, and leave
`zerostel install` to the user.

## Look before anything else

- `zerostel log`: the timeline of the latest session, one line per step.
  `--changes` keeps only the steps that changed files, `-n 50` shows more.
- `zerostel show <n>` and `zerostel diff <n>`: one step, and exactly what it changed.
- `zerostel sessions`: every recorded session here; add `--session <id>` to the
  other commands to look at an older one.
- `zerostel find <path>`: every step, in every session, that touched a file.
- `zerostel status`: which agents are being recorded.

Quote step numbers from the log when you talk about them, so the user can
check them.

## Going back changes files: ask first

1. Find the step with `zerostel log`, then run `zerostel rewind <n> --dry-run`
   and show the user which files would change.
2. Rewind only after the user agrees. `zerostel rewind <n>` goes back to just
   before step n, `--after` to just after it, and `zerostel rewind 0` to point
   zero: the project before the session started.
3. Tell the user that `zerostel undo` takes the rewind back if it was the wrong
   point. On its own, `zerostel undo` undoes the agent's last turn.

A rewind restores project files. It doesn't undo a push, a deploy, a sent
message or a global install; say so when the steps you'd rewind include one.

Never rewind to hide a mistake. If you broke something, say what and which
step, then offer the rewind.

## Guardrails

The user's rules live in `~/.zerostel/policy.json`. `zerostel policy` lists
them and `zerostel policy test "<command or path>"` shows what a command would
hit.

When a Zerostel rule blocks a tool call, or says the user has to agree first,
don't look for another way to do the same thing (a different command, another
tool, editing files under `~/.zerostel`). Tell the user what was stopped and
the reason the rule gave; the decision is theirs.

## Things that switch the recorder off: only when the user asks for them

Don't run `zerostel uninstall`, `zerostel prune` or `zerostel policy init --force`,
and don't edit anything under `~/.zerostel` or an agent's hook settings, unless
the user asks for exactly that. These stop the recording, delete it or replace
the user's rules.

## Checking a record

`zerostel verify` checks that a session's log hasn't been edited since it was
recorded: `intact` means every line checks out, `unchecked` means it was
recorded before Zerostel signed its logs, `broken` means lines were changed or
removed. Report the result as it is.
