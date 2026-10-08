# Commands

**Record**

| Command | |
|---|---|
| `zerostel install` | Add hooks to the agents found on this machine. `--agent gemini,copilot` to pick, `--agent all` for every non-experimental one. |
| `zerostel run -- <command>` | Record any agent or script without hooks, by snapshotting whenever files settle. |

**Look**

| Command | |
|---|---|
| `zerostel log` | Timeline of the latest session in this project. `-n 20` for the last 20 steps, `--changes` for steps that changed files. |
| `zerostel ui` | Sessions, timeline and diffs in a local web page, with rewind and undo buttons. |
| `zerostel sessions` | Every recorded session in this project. |
| `zerostel show <n>` / `zerostel diff <n>` | The command, output and files of step *n*, or its exact diff. |
| `zerostel find <path>` | Every step, in every session, that touched a file. |

**Go back**

| Command | |
|---|---|
| `zerostel undo` | Back to before the agent's last turn that changed files. Run it again right after to undo the undo. |
| `zerostel rewind <n>` | Back to just before step *n* (`--after` for just after, `0` for point zero). Without *n* it lists the steps and asks. `--only <path>` for part of the project, `--dry-run` to preview. |
| `--keep-others` | With `undo` or `rewind`: leave files that another agent's session, or you outside the agent, changed since then as they are. The preview names those files either way. |
| `zerostel snapshot -m "msg"` | Save a checkpoint by hand. |

A rewind never deletes or overwrites a file the snapshot it takes first has no exact copy of (one git couldn't read, one left out of snapshots, one another program wrote while the rewind ran); it lists those instead. `zerostel log` marks steps that ran with no snapshot just before them, so you can see which points a rewind can reach.

**Check the work**

| Command | |
|---|---|
| `zerostel checks` | Every test, type check, linter and build the session ran: passed, failed, or **out of date** because the code changed after it ran. For a test run that failed, which tests failed (`zerostel log` shows them too). Also flags test files the session changed or deleted. |
| `zerostel check -- <command>` | Run one yourself (`zerostel check -- npm test`) and record its result against the code as it is now. Exits with the command's exit code. |
| `zerostel handoff` | What the next agent or person needs to carry on: your prompts (the only instructions in it), which files differ, which checks still hold, what was tried and undone, what isn't covered. `-o file` to save it. |
| `zerostel handoff check <file>` | Whether the folder still matches a handoff, and which files changed if not. |

A check the agent ran counts as passed only when the agent reports the result (Claude Code, Cursor and Copilot CLI send failed tool calls separately; for the others Zerostel looks for an exit code in what the agent reports). A command whose exit status can't be the check's own (`npm test | tail`, `npm test || true`) is treated the same way. When the result is unknown, it shows as "result not reported", never as "passed".

Which tests failed comes from the end of the output Zerostel already recorded (nothing is run again), as vitest, jest, pytest, go test, cargo test, TAP and node --test, dotnet test, rspec and Gradle print it: at most 20 names. A handoff says how many failed but not which: it copies no tool output.

**Share and check**

| Command | |
|---|---|
| `zerostel report --open` | The session as one self-contained HTML page. |
| `zerostel report --share` | A version for other people: no prompts, commands, output or diffs in the file. |
| `zerostel verify` | Check that the session's log hasn't been edited since it was recorded (`--all` for every session). |

**Guardrails**

| Command | |
|---|---|
| `zerostel policy init` | Write a starter policy: no credentials, ask before force-pushing or editing `.env`. |
| `zerostel policy` | Show your rules. |
| `zerostel policy test "<command or path>"` | See which rule, if any, it would hit. |

**Housekeeping**

| Command | |
|---|---|
| `zerostel status` / `zerostel doctor` | What's installed and recording; a full check you can paste into a bug report. |
| `zerostel prune` | Drop sessions older than 30 days (`--older-than 7d`) and the snapshots only they used. |
| `zerostel projects` | Every project with recordings, including ones you moved; use `--project <id>` with any command. |
| `zerostel config` | Show settings. |
| `zerostel completion <shell>` | Tab completion for bash, zsh, fish or PowerShell, e.g. `eval "$(zerostel completion bash)"`. |
| `zerostel uninstall` | Remove the hooks. Recordings stay in `~/.zerostel` until you delete it. |

`--session <id>` picks an older session, `--json` gives machine-readable output, `-y` skips the confirmation.

For recording, `zerostel install` is usually all you need; [install.md](install.md) has the other ways in.
