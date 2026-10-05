# Zerostel and other tools

Zerostel isn't the only way to get work back from a coding agent. The agents keep adding checkpoints of their own, and several open-source projects record agents and undo what they did. This page says what each one does, what Zerostel adds, and when something else is the better pick.

The descriptions below come from each project's own README as of October 2026, not from testing them. They change quickly: check the links for the current state, and tell us in [Discussions](https://github.com/zerostel/zerostel/discussions) if something here is out of date.

## The agents' own checkpoints

Most agents have some form of checkpoint or undo by now, and some bring the conversation back together with the files, which Zerostel doesn't. What they miss is mostly changes made by shell commands, ignored files such as `.env`, and anything outside one agent. [What each agent's undo brings back](comparison.md) has the details and sources. They work alongside Zerostel: rewind the conversation in the agent, and the files with Zerostel.

## Other tools

| Tool | What it does, from its README | Pick it if |
|---|---|---|
| [Turnback](https://github.com/MFaizR77/turnback) (MIT, npm) | One undo history for Claude Code, Codex, Cursor, Gemini CLI, OpenCode and Antigravity CLI. Snapshots the workspace into a shadow git repo before every shell command and edit; undo a turn or go back to a step; ignored files up to 5 MB; per-line blame, recovering one file, a pull-request summary, a web UI and an MCP server; automatic cleanup, and an edits-only mode for very large workspaces. Files only, not the conversation. | You want per-line blame (which turn wrote this line) or automatic cleanup of old turns. |
| [Turnal](https://github.com/AadiJo/turnal) (Apache-2.0, Go) | A local flight recorder with private git checkpoints for Claude Code, Codex, Cursor, Pi, OpenCode and Copilot CLI: diffs per turn, line attribution, rollback, token usage and cost, checks run against recorded checkpoints, bisecting the turn that broke them, and Attempts compared in isolated worktrees. Releases are at 0.0.x; some of this is on its main branch. | You want to bisect which turn broke the tests, or try several attempts side by side. |
| [bashback](https://github.com/trouties/bashback) (AGPL-3.0, Go) | Snapshots around every shell command for Claude Code, Codex CLI and Cursor, with command-level list, diff and undo, and an undo that refuses with an explanation when it would surprise you. One static binary. | Undo for shell commands is all you need. |
| [logbook](https://github.com/sheeki03/logbook) (Apache-2.0, Rust) | Records Claude Code, Codex, Aider or any CLI into a local timeline, with secrets scrubbed as they are captured, a scan for risky actions (`logbook detect`), a web UI, and revert for sessions that started from a clean tree. Can also record raw model traffic through a local proxy. | You want sessions scanned for risky commands and leaked secrets, or full model traffic recorded. |
| [codex-rewind](https://github.com/extracurricular-ai/codex-rewind) (Apache-2.0) | An unofficial distribution of Codex CLI, installed as `codexr`, adding `/rewind` and `/redo` that bring the conversation and the files back together. | You use Codex and want the conversation rewound with the files. |
| [ccundo](https://github.com/RonitSachdev/ccundo) (MIT) | Undo and redo for Claude Code, read from its session files, with previews and cascading undo. | You use Claude Code and want undo without installing hooks. |

## What Zerostel adds

- **Rewinds that don't lose work.** Nothing is deleted or overwritten without an exact copy in the snapshot taken just before; every file is looked at again right before it changes, so one another program wrote meanwhile is left alone; `--keep-others` keeps what another agent or you changed since; and every rewind, even one cut short, can be undone. See the [security model](security-model.md).
- **More than the project folder.** Watched files such as `~/.zshrc`, Windows user environment variables, and global package installs, which are listed with the commands that undo them.
- **Evidence tied to the code.** Every test, type check and build is recorded against the exact code it ran on, so a pass on code that has changed since shows as out of date, and one whose result the agent didn't report never counts as passed. A [handoff](commands.md) gives the next agent or person your asks and where things stand, and they can check the folder still matches.
- **One set of rules for every agent.** [Guardrails](guardrails.md) that block a tool call, or ask you first, before it runs, the same for every agent; and a log that shows if it was edited afterwards.
- **Your agents as they are.** Hooks into the official Claude Code, Codex, Cursor, Gemini CLI, Antigravity, Copilot CLI and opencode: no fork, no wrapper around the agent. `zerostel run` covers anything else.
- **Built to be trusted on your machine.** Zero runtime dependencies, nothing sent over the network, every repository treated as hostile, releases built by CI with provenance, and single executables for Windows, macOS and Linux. On Windows it handles junctions, short names and `cmd.exe` quoting itself.

## Where Zerostel stops

- It rewinds files, not the conversation: tell the agent what you undid, or start a new session.
- It isn't a sandbox: network requests, deployments and database writes can't be taken back.
- It puts back whole files: when two agents changed the same file, it doesn't merge their edits.
- It can't yet bisect which step broke a check; `zerostel checks` says which check broke and when it last passed.

The full list is under [Limits](../README.md#limits).
