# What agents' own checkpoints bring back

As of October 2026. Most of this comes from each agent's source code; the rest from official docs or maintainers' replies, and "not documented" marks what neither settles. Agents change quickly, so check the date before relying on a row.

## In one paragraph

Whether an agent can undo what a **shell command** did depends on how it takes checkpoints. Agents that snapshot the whole working tree with git (Cline, opencode and Kilo, Zed, Gemini CLI's `/restore`) can bring back files a command changed, as long as they weren't ignored by `.gitignore`. Agents that only track the files their own edit tools touched (Claude Code's `/rewind`, Cursor, VS Code Copilot, Gemini CLI's `/rewind`, Aider) can't. No agent backs up ignored files such as `.env`, and most snapshot tools don't work outside a git repository.

## Side by side

| Agent | How | Where it's kept | Undoes shell changes | Works without a git repo |
|---|---|---|---|---|
| Claude Code `/rewind` | tracks its edit tools | inside Claude Code | no (documented) | yes |
| Cursor | tracks its edit tools, per prompt | inside Cursor; gone with the chat | no | yes |
| Codex CLI | no file undo (`/undo` was removed in 2026) | — | no | — |
| Codex app and IDE extension | reverses the diff | refs in **your own `.git`** | partly | no |
| Cline | commits the whole tree after each tool call | a separate shadow repo | yes | yes |
| opencode, Kilo | `write-tree` before and after each step | a separate git dir | yes | no |
| Zed | snapshot when a message is sent | **your own `.git`**, unreferenced | yes (new files stay) | no |
| Gemini CLI `/restore` | whole tree before edit tools (off by default) | `~/.gemini/history` | indirectly | yes |
| Gemini CLI `/rewind` | before and after of edits | in the session | no | yes |
| VS Code Copilot | snapshot of affected files per request | not documented | no (documented) | yes |
| Copilot CLI | files Copilot changed | not documented | not documented | yes |
| Aider `/undo` | commits to your git | **your own `.git`** | no | no |

## What goes wrong, and what Zerostel does about it

- **A restore that destroys.** One agent's restore ran `git clean -fd` and deleted over a gigabyte of untracked data (github/copilot-cli#1675); another did the same to untracked files while `.gitignore` had uncommitted changes (cline/cline#14367). Zerostel only touches files that differ between two of its snapshots, and never deletes what it hasn't backed up.
- **A `.git` that fills up.** Checkpoint refs grew one repository past 100 GB (openai/codex#29388). Zerostel writes only to its own shadow repository and never to yours.
- **Snapshots collected as garbage.** A background `git gc --prune=7.days` can delete snapshot objects that older sessions still need for diffs and undo, and has already broken review diffs (anomalyco/opencode#36093). Zerostel keeps every snapshot on one referenced chain, and `zerostel prune` says what it removes.
- **A rewind that silently does nothing.** In auto mode Claude Code is told to edit files through Bash, which `/rewind` doesn't track, so it reports success and leaves every change on disk (anthropics/claude-code#87575). Zerostel snapshots around shell commands too, and checks the files after a rewind.
- **Large repositories that stall.** Per-turn delays of about 90 seconds have been reported on big repositories (cline/cline#13131). Zerostel takes a project's first snapshot in the background and in chunks, and later snapshots only look at what changed; the numbers are in the README's FAQ.
- **Sessions that undo each other.** Undo in one session can roll back another's changes. Zerostel lists every file a rewind will touch, and asks before it does.
- **A conversation that doesn't rewind.** Files come back, but the agent still remembers what it did and may carry on building on it. Zerostel says so after every rewind: rewind the agent too, or start a new session.
