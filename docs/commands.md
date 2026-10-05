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
| `zerostel snapshot -m "msg"` | Save a checkpoint by hand. |

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
