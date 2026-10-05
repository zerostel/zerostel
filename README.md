<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zerostel-logo-dark.svg">
  <img src="docs/assets/brand/zerostel-logo-light.svg" alt="Zerostel" width="380">
</picture>

**Rewind any AI agent to point zero.**

Zero trust for AI agents: assume they'll break something, record every step, and rewind the files they touched.
A flight recorder and time machine for coding agents, with guardrails you set and a log that shows if it was edited.

[Website](https://zerostel.com) · [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/zerostel)](https://www.npmjs.com/package/zerostel)
[![CI](https://github.com/zerostel/zerostel/actions/workflows/ci.yml/badge.svg)](https://github.com/zerostel/zerostel/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

```bash
npx zerostel install
```

Want to see it first? `npx zerostel demo` makes a throwaway project, plays one agent turn that deletes a folder and breaks the tests, and lets you undo it. No agent needed, and none of your projects are touched.

Then use your agent as usual. When it breaks something:

```bash
zerostel log          # what happened, step by step
zerostel undo         # put the files back to before the agent's last turn
zerostel rewind 0     # or all the way back to point zero, where the session started
zerostel ui           # the same, clickable, in a local web page
```

<p align="center"><img src="docs/assets/demo.svg" alt="zerostel log shows an agent deleting src/legacy with rm -rf; zerostel undo brings the files back" width="780"></p>

## Why

Agents edit dozens of files, run `rm`, `git checkout .`, migrations and build scripts. When something goes wrong you're left asking what it did and how to get back.

Some agents have checkpoints of their own, and they differ a lot. Claude Code's rewind skips changes made through Bash. Copilot CLI tracks shell commands. Cursor and Codex each have their own model. If you use more than one agent, you get a different answer to "what changed and can I get it back" in each.

Zerostel records every supported agent the same way: a snapshot of the project around each tool call that can change files, a timeline of prompts, commands, files, time and tokens, and a report you can hand to someone else. It never touches your `.git`.

| | Agent's own checkpoints | Commits / `git stash` | **Zerostel** |
|---|---|---|---|
| Changes made by shell commands | depends on the agent | only what you committed | ✅ inside the project, plus files you list |
| Go back to a specific step | usually per prompt | per commit | ✅ per tool call |
| Timeline of commands, files, tokens, time | partial | ❌ | ✅ |
| Log that shows if it was edited afterwards | ❌ | ✅ (commit hashes) | ✅ |
| Your own rules: block or ask before a tool runs | per agent | ❌ | ✅ same rules for every agent |
| Same behaviour across agents | ❌ one each | ✅ | ✅ |
| Writes to your `.git` | some do | ✅ | ❌ never |
| Shareable report of the session | ❌ | ❌ | ✅ |

Details and sources: [docs/comparison.md](docs/comparison.md).

## Zero trust, in practice

The idea behind the name: don't trust an agent because it usually behaves. Assume it can go wrong, see everything it does, and keep a way back. What Zerostel does today:

| Principle | What it means here |
|---|---|
| **Assume breach** | A snapshot before and after every tool call that can change files. Undo any turn, rewind to any step, or go back to point zero. |
| **See everything** | Every prompt, tool call, command, file change, duration and token count, in one timeline per session. |
| **Verify the record** | Each log line is chained to the one before with a keyed hash. `zerostel verify` says which line was edited, removed or reordered. |
| **The recorder isn't the agent's** | The starter rules keep `~/.zerostel` off limits and ask you before an agent uninstalls Zerostel or edits its hook settings. Rules can be talked around; the log can't: if the hooks disappear mid-session, the next hook call records it. |
| **Least privilege, your rules** | Guardrails in `~/.zerostel/policy.json` block a tool call, or make the agent ask you first, before it runs. |
| **Limit the blast radius** | Rewinds cover the project, the files you list (like `~/.zshrc`) and, on Windows, user environment variables, and every rewind can itself be undone. What a rewind can't take back is asked about first (see the starter rules) or listed with the commands that would undo it. |
| **Trust nothing it reads** | Zerostel treats every project as hostile: it never runs programs found in it, never follows links out of it, and strips terminal escape codes. |

What it doesn't do: it isn't a sandbox. It can't undo network requests, deployments or database writes, and an agent running as you can still do what you can do. See [Limits](#limits).

## Install

```bash
npx zerostel install          # one-off, nothing installed globally
npm install -g zerostel       # or keep the `zerostel` command around
```

Run `npx` from a folder you trust, such as your home folder: inside a project, npx prefers a copy of the package that the project itself provides. You need git, and Node 20 or newer for npm. No Node? Every release also has a single executable with Node inside, for Windows, macOS and Linux on x64 and arm64: download it from [Releases](https://github.com/zerostel/zerostel/releases), run `zerostel install`, and it copies itself to `~/.zerostel/bin`. `gh attestation verify <file> --repo zerostel/zerostel` checks that a download was built by this repository's release workflow. Homebrew and Scoop packages are coming; their templates are in [packaging/](packaging).

`zerostel install` copies itself to `~/.zerostel/bin`, so hooks keep working after an npx cache cleanup, and adds hooks to every agent it finds. It shows the change and keeps a backup of each config file it edits.

### Plugins, extensions and the skill

Each agent's own plugin system can install Zerostel too. All of them bring the same `zerostel` skill, which teaches the agent to read its timeline, preview a rewind and ask you before applying it, and leave the recorder alone.

| Agent | From inside the agent | What it adds |
|---|---|---|
| Claude Code | `/plugin marketplace add zerostel/zerostel`, then `/plugin install zerostel@zerostel` | recording, guardrails and the skill |
| Codex | `codex plugin marketplace add zerostel/zerostel`, then install Zerostel from the plugin list | the skill; recording comes from `zerostel install` |
| Antigravity | `agy plugin install https://github.com/zerostel/zerostel` | the skill; recording comes from `zerostel install` |
| Gemini CLI | `gemini extensions install https://github.com/zerostel/zerostel` | the skill; recording comes from `zerostel install` |
| Other agents that read skills | `npx skills add zerostel/zerostel` | the skill |
| MCP clients | `io.github.zerostel/zerostel` in the [MCP Registry](https://registry.modelcontextprotocol.io) | the MCP server (see below) |

In Claude Code, use the plugin or `zerostel install`, not both; if both are on, each event is still recorded once. No plugin starts the MCP server by itself: you add it, so you choose which program runs it (see below).

## Supported agents and systems

| Agent | How | Status |
|---|---|---|
| Claude Code | hooks | ✅ tested on real sessions |
| Codex | hooks (approve once with `/hooks`) | ✅ tested on real sessions |
| Cursor | hooks | ✅ CLI tested on real sessions; the CLI sends no prompt events, so undo goes one change at a time there. On Windows, start it from PowerShell: from Git Bash its hooks don't run |
| Gemini CLI | hooks (trusted folders only) | ✅ tested end to end¹; for Code Assist Standard/Enterprise and paid API keys, since personal accounts moved to Antigravity in June 2026 |
| Antigravity (CLI, desktop, IDE) | hooks | ✅ tested end to end¹; it doesn't pass on the prompt text, so turns show as "New turn" |
| Copilot CLI | hooks (`~/.copilot/hooks`) | ✅ tested on real sessions |
| opencode | plugin | ✅ tested on real sessions |
| DeepSeek Harness | plugin | 🧪 experimental (dsh itself is a developer preview); tested end to end¹ |
| anything else (Aider, scripts…) | `zerostel run -- <command>` watches the files | ✅ coarser: no tool calls, tokens or guardrails |

¹ The real agent on Windows, with its model swapped for a scripted one: a prompt, a file write, a command, a call blocked by a rule, the end of the turn and an undo.

Experimental agents are installed only when you name them: `zerostel install --agent deepseek`. Reports from real sessions are welcome.

Zerostel doesn't care which model is behind the agent: Claude, GPT, Gemini, DeepSeek or a local one are all recorded the same way.

Windows, macOS and Linux (WSL too). CI runs every commit on all three with Node 20, 22 and 24.

## Commands

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

## Guardrails

Rules live in `~/.zerostel/policy.json`. With no file there are no rules. `zerostel policy init` writes a starter set; besides the rules below, it asks before running as administrator (`sudo`), installing or removing software globally (`npm -g`, `pip --user`, `brew`, `winget`…), changing system or user settings (`setx`, `reg`, `crontab`…), writing to system folders, publishing or deploying (`npm publish`, `terraform apply`, `vercel --prod`…) dropping database tables, and switching Zerostel itself off (`zerostel uninstall`, `zerostel prune`, or editing an agent's hook settings). Rules match what a command says, so they slow an agent down rather than wall it in; hooks removed anyway show up in the log. An excerpt:

```json
{
  "rules": [
    { "action": "deny", "paths": ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.config/gcloud/**", "~/.zerostel/**"],
      "reason": "credentials, and Zerostel's own records, are off limits" },
    { "action": "ask", "paths": ["**/.env", "**/.env.*"], "access": "write", "reason": "changes a .env file" },
    { "action": "ask", "commands": ["git push --force*", "git push -f*", "git reset --hard*", "git clean -*f*", "* --no-verify*"],
      "reason": "rewrites or throws away git history" }
  ]
}
```

`zerostel policy init` writes a `$schema` line, so editors such as VS Code complete and check the file as you type (the schema is at `https://zerostel.com/schema/policy.json`; `config.json` has one too).

- **`paths`** match files a tool names, including paths that appear in shell commands. `~/` is your home folder; other relative globs start at the project root. `**` crosses folders, `*` doesn't. `"access": "write"` limits a rule to tools that can change files.
- **`commands`** match each part of a shell command (split at `&&`, `||`, `;`, `|`). `*` matches anything.
- **`tools`** match tool names, such as `"WebFetch"` or `"mcp__github__delete_*"`.
- **`deny`** stops the call before it runs, and the agent is told why. **`ask`** makes Claude Code ask you; agents that can't pause to ask block the call and tell the agent to check with you.

Commands are matched without regard to case, and split at `&&`, `||`, `;`, `|`, `&`, `( )`, `$( )` and backticks; paths like `$HOME/.ssh`, `%USERPROFILE%\.ssh` or Git Bash's `/c/Users/...` are recognised for what they are.

Blocked and asked-about calls show up in the timeline, the web UI and reports. A broken `policy.json` is reported by `zerostel status` and `doctor` rather than guessed at, and a problem inside Zerostel never blocks a tool. Guardrails are a seatbelt against mistakes, not a sandbox: a command can reach a file without naming it.

More ready-made rules (secrets, uploads, migrations, the main branch, MCP tools, dependencies, a strict file for CI), each tested: [docs/guardrails.md](docs/guardrails.md).

## Use it in CI

Agents running unattended in GitHub Actions get the same record, guardrails and report. The timeline goes to the job summary and the report is attached to the run:

```yaml
- uses: zerostel/zerostel@v0
  with:
    agent: claude-code
    policy: .github/zerostel-policy.json
    run: claude -p "make npm test pass" --permission-mode acceptEdits
```

Details in [docs/ci.md](docs/ci.md).

## Use it from the agent (MCP)

`zerostel mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so the agent itself can save a checkpoint before something risky, read its timeline, check a command against your rules, and rewind when you ask it to ("go back to step 12", "back to point zero"). Rewinds only preview until the call says to apply them, and work only on the project the agent was started in.

With `zerostel` installed globally (`npm install -g zerostel`), add it to Claude Code:

```bash
claude mcp add zerostel -- zerostel mcp
```

On Windows, use `claude mcp add zerostel -- cmd /c zerostel mcp`. Codex reads it from `~/.codex/config.toml`:

```toml
[mcp_servers.zerostel]
command = "zerostel"
args = ["mcp"]
```

Other agents take the same command and argument in their MCP settings.

## How it works

```
 agent ──hook──▶ zerostel ──▶ policy.json      block or ask before the tool runs
 (before and after  │
  every tool call)  └──────▶ ~/.zerostel/projects/<name>-<hash>/
                              ├─ snapshots.git      shadow repo, work tree = your project
                              └─ sessions/*.jsonl   prompts, commands, files, tokens, time (hash-chained)
```

- **Hooks.** The agent calls Zerostel before and after each tool call and at the start and end of each turn. Read-only tools are only logged; anything that can change files gets a snapshot before and after.
- **Shadow git repo.** Snapshots live in a separate repository whose work tree is your project. Your `.git`, branches, index and stash are never touched, and the project doesn't need to be a git repo. Files are stored byte for byte and identical content is stored once.
- **What's snapshotted.** Everything `.gitignore` doesn't exclude, minus dependency folders like `node_modules`. Small ignored files such as `.env` are still backed up, because an agent deleting them is exactly when you need them back. Files you list under `watch` (outside the project) are kept in a repo of their own.
- **Safe rewinds.** Before restoring, Zerostel snapshots the current state, so every rewind can be undone. It only removes what that snapshot holds a copy of, never follows a symlink or junction out of the project, and checks the result afterwards.
- **A log you can check.** Each event line carries an HMAC of the previous line and itself, keyed by `~/.zerostel/audit.key`.
- **Never in the way.** Hooks print nothing unless a rule fires, always exit 0 and log their own errors. If Zerostel has a problem, the agent carries on.

More in [docs/architecture.md](docs/architecture.md).

## Configuration

`~/.zerostel/config.json` (all keys optional):

```json
{
  "maxFileMB": 25,
  "snapshotTimeoutSec": 20,
  "retentionDays": 30,
  "exclude": ["data/**", "*.sqlite"],
  "watch": ["~/.zshrc", "~/.bashrc", "~/.gitconfig"]
}
```

- **`maxFileMB`** — new files above this size aren't snapshotted. The timeline says so.
- **`snapshotTimeoutSec`** — if one snapshot takes longer, snapshots pause for an hour in that project and the timeline keeps recording.
- **`exclude`** — git pathspec globs that are never snapshotted.
- **`watch`** — files under your home folder to snapshot and rewind along with every project (up to 1 MB each). A change to one shows up as its own step.

## Privacy and security

Everything stays on your machine; nothing is uploaded. `~/.zerostel` is readable only by you.

The timeline keeps prompts, commands and the tail of command output. API keys, tokens and passwords are masked on a best-effort basis; don't rely on it for secrets in unusual formats. File contents live only in the snapshot repo. Reports leave `.env`-style files out, and `--share` leaves out prompts, commands, output and diffs entirely. File paths and timing stay in.

Zerostel treats the project as untrusted: file names can't turn into git options or patterns, links can't lead a snapshot or rewind outside the project, programs in the project folder are never started in place of git or the shell, and terminal escape codes in output are stripped. `zerostel ui` listens on 127.0.0.1 only and needs a random token from the link it prints. [docs/security-model.md](docs/security-model.md) explains what Zerostel protects and what it doesn't; see [SECURITY.md](SECURITY.md) to report a problem.

## Why the name

**Zero** trust + **Stella**, the stars. AI agents are multiplying like stars in the night sky; Zerostel is the single point they all come back to: a record you can check and a way back to point zero.

## FAQ

**How much does it slow the agent down?** Measured with `scripts/bench.mjs` on Windows 11 (a laptop i9), where starting processes is slowest:

| | 1,000 files | 10,000 files | 50,000 files |
|---|---|---|---|
| a tool call that only reads | 0.16 s | 0.16 s | 0.16 s |
| a tool call that edits (snapshot before and after) | 1.0 s | 1.2 s | 1.9 s |
| the first snapshot of a project, in the background | 3 s | 35 s | 5 min |

The first snapshot reads every file once; it starts as the session opens and the agent doesn't wait for it. Steps taken before it's done are recorded without one. Snapshots take roughly the size of the project, compressed, plus what changes. Run `npm run build && node scripts/bench.mjs` to measure your machine.

**Isn't git enough?** If you commit or stash at the right moments, git is a fine recovery tool. Agents change things between commits, often through shell commands, and nobody commits before every tool call. Zerostel does the equivalent automatically, in a repository of its own, so your history stays clean. Keep git and normal backups for durable history.

**What about jj?** Jujutsu snapshots the working copy whenever you run a `jj` command and has an operation log with undo. If your agents run jj at the right moments, it covers much of the same need. Zerostel adds the per-step timeline, guardrails and reports, and doesn't need anyone to run anything.

**Shouldn't this be built into the agent?** Several agents have checkpoints and permission rules, and if yours covers your workflow, use them. Zerostel is for when you want one record, one set of rules and one undo that work the same way across agents. They don't conflict.

**How is it different from snap-back or Entire?** snap-back also keeps shadow-git snapshots with undo. Entire links agent sessions to your commits. Zerostel ties snapshots to individual agent steps and adds the timeline, guardrails, a verifiable log, the web view and shareable reports.

**Is it a sandbox?** No. Guardrails stop the tool calls your rules name, and rewinds put files back. For untrusted code, also run the agent in a container or a separate account.

**Does undo reverse everything the agent did?** No. It puts captured files back: the project, and the files you listed under `watch`. Global packages a command installed or removed (npm, pip, Homebrew) show up as a step with the commands that would undo them; Zerostel lists them on rewind but never runs them. On Windows, user environment variables changed with `setx` and the like are put back. It doesn't undo network requests, deployments, database writes or changes to your real `.git`, and it doesn't rewind the agent's conversation. Rewind that in the agent too, or start a new session.

**Can I undo one agent while another keeps working?** Not safely. An undo restores the whole project (or the paths you give `--only`), including changes another agent or you made in the meantime. Preview with `--dry-run`, and give agents that run at the same time separate worktrees.

**How much disk does it use?** Identical content is stored once and compressed. `zerostel status` shows the total, and `zerostel prune` drops old sessions.

**Is the token count my bill?** No. It's read from the agent's transcript where the format is known, and shows "not captured" when it isn't. `zerostel run` can't see tokens at all. Your provider's dashboard is the source of truth.

## Limits

- Only states that were captured can be restored. Recording that starts after a deletion can't bring the file back.
- Inside one shell command there are no intermediate states: a file created and deleted by the same command is never seen. `zerostel run` snapshots when files settle, so it can miss short-lived files too.
- Outside the project, only files you list under `watch` are snapshotted, and only files under your home folder. On Windows, user environment variables (`HKCU\Environment`) are read around commands that change them and put back by rewinds; their values are kept in the session log on your machine, never in reports. Global packages are only listed, with the commands to undo them. Rewinds leave alone watched files that didn't exist at the target point. Everything else outside the project isn't covered; the timeline still shows the command that touched it.
- Not snapshotted, and listed by `zerostel log` when present: ignored folders (`node_modules`, `dist/`, anything in `.gitignore`), nested git repositories and submodules, linked folders (symlinks, junctions) and new files above `maxFileMB`.
- Agents started in your home directory or a drive root get a timeline but no snapshots.
- On case-insensitive file systems (Windows, macOS by default) a rename that only changes case, such as `readme.md` → `README.md`, isn't seen as a change.
- Under WSL, projects on the Windows drive (`/mnt/c/...`) are slow to snapshot. Keep them in the Linux file system.
- The audit chain shows a log was edited by anything that doesn't have your `audit.key`. Someone using your own account can read the key and rewrite a log completely; keep `~/.zerostel/**` in a deny rule so the agent can't.
- Guardrails match what a tool call names. A script or command that reaches a file without naming it gets through.

## Roadmap

- **Done:** recording and rewinding seven agents, point zero, web UI, shareable reports, verifiable logs, guardrails, MCP server, watched files outside the project.
- **Next:** signed reports anyone can verify without your key; recording calls to other MCP servers through a Zerostel gateway; test-output parsing to say which test broke; real-session validation of the experimental agents.

## Troubleshooting

Run `zerostel doctor`. It checks Node, git, each agent's hooks and version, the config file, snapshot coverage, the latest session's audit chain, your guardrails and recent hook errors, and its output is safe to paste into an issue (home paths are shortened to `~`).

## Contributing

Supporting a new agent means adding one adapter to [src/agents/adapters.ts](src/agents/adapters.ts). See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

```bash
npm install && npm test && npm run smoke
```

## License

[Apache-2.0](LICENSE)
