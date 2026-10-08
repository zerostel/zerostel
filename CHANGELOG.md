# Changelog

## Unreleased

Maintenance

- CI tests every commit on Node 26 too, on Linux, macOS and Windows; the demo recording image moved to Node 26 (#14).
- Node 20 reached end of life in April 2026. Zerostel still runs on it, but a later release will need Node 22 or newer.
- zerostel.com no longer serves the maintainers' notes about the site folder; they moved to `docs/website.md` (#13).

## 0.2.1 (2026-10-05)

Fixes to 0.2.0's checks, handoffs and `--keep-others`, from a second review. After upgrading, run `zerostel install` once more.

- `--keep-others` also keeps files you edited by hand after the agent's last step, before any hook had recorded them, and looks again right before the rewind runs, in case something changed while the question was on screen.
- `zerostel check --project <path>` runs the command in that project, not in the folder you happen to be in, so the result is tied to the code it actually ran on. The folder it ran in is recorded with it.
- A handoff says "every recorded check passed on the code as it is now" only when there are checks, all of them passed, and all of them ran on the current code. A pass whose freshness can't be told, or a session with no checks at all, is said to be unconfirmed.
- A handoff saved inside the project no longer makes `zerostel handoff check` report the project as changed.
- A check piped into another command counts as passed only after a real `set -o pipefail` (or `set -euo pipefail`) before it; the word anywhere else, in an argument or a comment, no longer does.

## 0.2.0 (2026-10-05)

Check the work, hand it over, and rewind without taking back other people's. After upgrading, run `zerostel install` once more so your agents' hooks run the new version.

Check the work

- `zerostel checks`: every test, type check, linter and build a session ran, tied to the snapshot of the code it ran on. A pass on code that has changed since shows as out of date, a check that passed and then failed says so, and test files the session changed or deleted are flagged. Agents' own runs are picked up from their shell commands; a result counts as passed only when the agent reports it.
- `zerostel check -- <command>` runs a check and records it against the code as it is now. Guardrails look at the command inside it (and inside `zerostel run --`) too.
- A check that keeps failing run after run (three or more in a row, up to now) is pointed out in `zerostel log`, `zerostel checks` and handoffs: the agent may be going in circles.
- Reports list the session's checks and whether the code changed after each one; the shared version names their kind, not the command.

Hand it over

- `zerostel handoff` writes what the next agent or person needs to carry on: your prompts (the only instructions in it), the files that differ, which checks still hold, what was tried and undone, and what isn't covered. No tool output is copied in. `zerostel handoff check <file>` says whether the folder still matches.
- The MCP server has `checks` and `handoff` tools, and `rewind` takes `keep_others`.

Rewinds

- A rewind's preview names the files another agent's session, or you outside the agent, changed since then; `--keep-others` leaves them as they are.
- A rewind looks at every file a second time right before deleting or overwriting it, a few at a time, and leaves alone any that another program (the agent, an editor, a build) wrote since it was backed up.
- On a new project, a prompt that comes while the first snapshot is still being taken in the background helps finish it, so it gets its snapshot. If a turn still has none from before its prompt, `zerostel undo` goes back as far into the turn as there is one, instead of undoing only its last step.
- `zerostel log` marks steps that ran with no snapshot just before them, and says why; `zerostel status` says when the first snapshot is still being taken.
- The web UI marks the tests and builds the agent ran, and the steps with no snapshot.

Security

- On Windows, a guardrail check no longer looks up a network path (`\\server\share`) on another server: looking it up connects to that server and can hand it your sign-in. Rules still match it as written.

Docs

- [Zerostel and other tools](docs/alternatives.md): Turnback, Turnal, bashback, logbook, codex-rewind and ccundo, what each does, and when one of them fits better. The README has the short version.
- [What each agent tells Zerostel](docs/install.md#what-each-agent-tells-zerostel): prompts, "ask" rules, failed commands and tokens, agent by agent.
- README: the comparison with git now credits `git stash` with keeping uncommitted work.

## 0.1.3 (2026-10-05)

Fixes from a security and data-safety review. After upgrading, run `zerostel install` once more so your agents' hooks run the new version; the snapshot store updates itself on first use.

Rewinds never lose work

- A rewind no longer deletes or overwrites a file the snapshot it took just before has no exact copy of. That covers a file git couldn't read (locked by another program, no permission, a full disk), and a file snapshots leave out (`exclude`, over the size limit, ignored) that the rewind would have written over. Such files are left alone and listed, in the preview too.
- A `.gitattributes` `working-tree-encoding` that git can't apply no longer makes it skip every file in a snapshot.
- Snapshots that couldn't copy every file say so, in `errors.log` and after `zerostel snapshot`, instead of reporting "no changes".
- A rewind cut short (the process killed, a power cut) is recorded before it starts, so `zerostel undo` can still take it back, and `prune` keeps the snapshot it needs.
- A watched file that grew past 1 MB is no longer replaced with its older, smaller copy.
- An agent started in a folder above your home folder (`C:\Users`, `/home`) gets a timeline but no snapshots: each one would have copied Zerostel's own store into itself. A data folder placed inside a project is left out of its snapshots and never written to by a rewind.
- On Windows, user environment variables are read as Unicode, so a rewind no longer writes back a value with a non-English folder name garbled. Values recorded garbled by earlier versions, and values that aren't plain strings, are left alone.
- A lock left by a process that has exited is cleared at once, and one whose owner is still running is never taken over, however long it runs. A long `prune` could otherwise lose a snapshot taken while it ran.
- A file in a snapshot that is later replaced by a link to a folder no longer pulls that folder into the next snapshot (Windows).

Agents and hooks

- The MCP server's `rewind` applies only with the confirm code its preview gave, and only if the project hasn't changed since. The preview names the session it rewinds. It puts back project files only; watched files and environment variables are left to `zerostel rewind` in a terminal.
- Guardrails now see a path under any argument name, `file:` URLs included.
- File names with line breaks can't draw fake lines in `zerostel log` and other output.
- A real secret that happens to contain a word like "example" or "test" is no longer mistaken for a placeholder and left unmasked.
- A call too big to check in full is asked about only when you have path or command rules.

Install and uninstall

- Codex and Antigravity hooks are refused, with a clear message, when the data folder's path has characters cmd.exe would read as commands; before, such a path could run a program from the project folder. `%` no longer counts as a plain path character.
- PowerShell hooks quote typographic apostrophes (`’`) in paths.
- `zerostel uninstall` leaves config files without Zerostel's hooks exactly as they are, and a config it can't read for one agent no longer stops install or uninstall for the others.
- Hook settings laid out in a way the agent wouldn't read are refused instead of rewritten; a read-only config leaves no temporary copy behind; a Copilot hooks file you added your own hooks to is backed up before uninstall removes it.
- `zerostel doctor` notices when the Node a Windows hook runs has gone (a version manager removed it), and install warns when that Node looks temporary.
- On Windows, a first snapshot of a project too big for a hook to scan goes on in the background instead of pausing snapshots for an hour.
- Cursor gets no answer, rather than one that could block a tool, when its hook payload can't be read; the opencode and DeepSeek plugins can't fail a tool call over arguments JSON can't hold.
- `zerostel rewind --only .` means the whole project.

## 0.1.2 (2026-10-05)

- A step that deleted files keeps its warning mark on its own line in `zerostel log`, instead of wrapping it onto the next one.
- After an undo or a rewind, the suggested commands start with `npx zerostel` when you ran Zerostel through npx, as the demo's already did.

## 0.1.1 (2026-10-05)

No changes to what Zerostel records or rewinds; this release brings the package page and the release process up to date.

- The README on npm links the website and the security model in every language, no longer promises Homebrew and Scoop packages that aren't out yet, and answers "does it slow the agent down?" once, with the measured numbers. The package's homepage is now zerostel.com.
- Contributor docs: how pull requests work, supported versions and how to report a vulnerability, a feature request form and a support page.
- Releases are built and staged on npm by CI through trusted publishing, with no npm token anywhere, and go live only when a maintainer approves them with two-factor authentication. The MCP Registry entry is published the same way, with GitHub OIDC.
- The GitHub Action uses `actions/upload-artifact` v7, which needs Actions Runner 2.327.1 or newer on self-hosted runners.

## 0.1.0 (2026-10-05)

Record

- Record Claude Code and Codex sessions through their hooks: prompts, tool calls, file changes, durations and token usage.
- Also records Cursor, Copilot CLI, opencode, Gemini CLI and Antigravity (CLI, desktop and IDE), each tested on Windows.
- Experimental support for DeepSeek Harness, through a native plugin, tested end to end.
- `zerostel run -- <command>` records any other agent or script by watching file changes.
- Snapshots in a separate shadow git repo per project; the project's own `.git` is never touched.
- Files outside the project (`watch` in config.json), global package installs and Windows user environment variables are recorded too.

Look and go back

- `log`, `sessions`, `show`, `diff` and `find` to look at what happened; `ui` for the same in a local web page.
- `undo`, `rewind <n>` (with `--after`, `--only`, `--dry-run`) and `snapshot` to go back; every rewind can itself be undone.
- `report` exports a session as a single HTML page with secrets masked; `--share` leaves out prompts, commands, output and diffs.
- `zerostel demo` sets up a throwaway project with one recorded agent turn to try it on.

Zero trust

- Guardrails in `~/.zerostel/policy.json` block a tool call, or make the agent ask first, before it runs. `policy init` writes a starter set, `policy test` shows what a command would hit.
- The starter rules ask before an agent uninstalls Zerostel or edits its own hook settings, and hooks removed mid-session are written into the log.
- Each session log is chained with a keyed hash; `zerostel verify` says which line was edited, removed or reordered.

Everywhere

- `zerostel mcp`: an MCP server with checkpoint, timeline, rewind (preview first), verify and policy checks.
- A Claude Code plugin, a Codex plugin, a Gemini CLI extension and a shared agent skill; an MCP Registry entry.
- A GitHub Action that records agents in CI, applies the guardrails and attaches the report.
- Standalone executables with Node inside for Windows, macOS and Linux on x64 and arm64, with build provenance.
- Tab completion for bash, zsh, fish and PowerShell; JSON schemas for policy.json and config.json.
